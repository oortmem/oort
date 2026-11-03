import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendPrivateFile, ensurePrivateDir } from './private-fs.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-private-fs-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const posix = process.platform !== 'win32';
const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe('private-fs', () => {
  it.runIf(posix)('private-fs.creates-dir-0700', () => {
    const dir = path.join(root, 'a', 'b');
    expect(ensurePrivateDir(dir)).toBe(false);
    expect(mode(dir)).toBe(0o700);
  });

  it.runIf(posix)('private-fs.tightens-existing-dir', () => {
    const dir = path.join(root, 'loose');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    expect(ensurePrivateDir(dir)).toBe(true);
    expect(mode(dir)).toBe(0o700);
  });

  it.runIf(posix)('private-fs.append-creates-0600-and-tightens', () => {
    const dir = path.join(root, 'files');
    const file = path.join(dir, 'x.jsonl');
    appendPrivateFile(file, 'one\n');
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    fs.chmodSync(file, 0o644);
    appendPrivateFile(file, 'two\n');
    expect(mode(file)).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });
});
