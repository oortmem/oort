import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Failure injection for the blob layer's cleanup: `rename` and `unlink` fail
 * on demand, everything else is the real file system.
 */
const fail = vi.hoisted(() => ({
  rename: new Set<string>(),
  unlink: new Set<string>(),
  unlinked: [] as string[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const unlinkSync = (file: import('node:fs').PathLike): void => {
    const name = path.basename(String(file));
    fail.unlinked.push(name);
    for (const part of fail.unlink) {
      // Only committed names (`<id>.<pid>-<rand>.zst`), never their `.tmp`.
      if (name.startsWith(part) && name.endsWith('.zst')) {
        throw Object.assign(new Error(`EACCES: unlink ${name}`), { code: 'EACCES' });
      }
    }
    real.unlinkSync(file);
  };
  return { ...real, default: { ...real, unlinkSync }, unlinkSync };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const rename = async (from: string, to: string): Promise<void> => {
    for (const part of fail.rename) {
      if (path.basename(to).startsWith(part)) throw new Error(`injected rename failure ${part}`);
    }
    await real.rename(from, to);
  };
  return { ...real, default: { ...real, rename }, rename };
});

const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
const { openBlobDir } = await import('./blobs.js');

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oort-blobs-'));
}

afterEach(() => {
  fail.rename.clear();
  fail.unlink.clear();
  fail.unlinked.length = 0;
});

describe('blob cleanup', () => {
  it('blobs.cleanup-keeps-original-error', async () => {
    const dir = freshDir();
    const blobs = openBlobDir(dir, () => {});
    const data = new Uint8Array([1, 2, 3]);
    // `c` fails to rename after `a` and `b` were renamed; removing `a` then fails too.
    fail.rename.add('c.');
    fail.unlink.add('a.');
    const err: unknown = await blobs
      .writeMany(['a', 'b', 'c', 'd'].map((id) => ({ id, data })))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    // The original failure is what the caller sees, with the cleanup failure attached.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('injected rename failure c.');
    const cause = (err as Error).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      expect.stringMatching(/^EACCES: unlink a\./),
    ]);
    // Cleanup went on past the failing unlink: every other file this call created is gone.
    const left = fs.readdirSync(dir).filter((f) => f.endsWith('.zst') || f.endsWith('.tmp'));
    expect(left).toEqual([expect.stringMatching(/^a\.\d+-[0-9a-f]{8}\.zst$/)]);
    expect(fail.unlinked.some((n) => n.startsWith('d.'))).toBe(true);
  });

  it('blobs.remove-all-is-best-effort', async () => {
    const dir = freshDir();
    const blobs = openBlobDir(dir, () => {});
    const names = await blobs.writeMany(
      ['a', 'b', 'c'].map((id) => ({ id, data: new Uint8Array([1]) })),
    );
    fail.unlink.add('a.');
    const failures = blobs.removeAll(names);
    expect(failures.map((e) => (e as Error).message)).toEqual([
      expect.stringMatching(/^EACCES: unlink a\./),
    ]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.zst'))).toEqual([names[0]]);
  });
});
