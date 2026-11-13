import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildNative, pinnedToolchain } from './build-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A stand-in for spawnSync that records each call and answers like rustup's cargo and rustc
 * would. `rustcVersion` is what `rustc --version` prints; `cargo` is false when cargo is missing
 * (or, with `rustup`, when rustup has not installed the pinned toolchain).
 */
function fakeRust({
  rustcVersion = 'rustc 1.99.1 (0123456789 2026-10-29)',
  host = 'x86_64-unknown-linux-gnu',
  cargo = true,
  rustup = false,
  buildStatus = 0,
} = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd, toolchain: opts?.env?.RUSTUP_TOOLCHAIN });
    if (cmd === 'rustup') {
      return rustup ? { status: 0 } : { status: null, error: new Error('ENOENT') };
    }
    if (cmd === 'cargo' && !cargo) {
      return rustup ? { status: 1 } : { status: null, error: new Error('ENOENT') };
    }
    if (cmd === 'cargo' && args[0] === '--version') return { status: 0, stdout: 'cargo 1.99.1\n' };
    if (cmd === 'rustc' && args[0] === '--version')
      return { status: 0, stdout: `${rustcVersion}\n` };
    if (cmd === 'rustc' && args[0] === '-vV') {
      return { status: 0, stdout: `${rustcVersion}\nhost: ${host}\nrelease: 1.99.1\n` };
    }
    if (cmd === 'cargo') return { status: buildStatus };
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
  return { calls, spawn };
}

let dir;
let logs;
const log = (line) => logs.push(line);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-build-native-'));
  fs.writeFileSync(
    path.join(dir, 'rust-toolchain.toml'),
    '# comment\n[toolchain]\nchannel = "1.99.1"\nprofile = "minimal"\n',
  );
  // What cargo would leave behind for each build these tests run.
  for (const [sub, lib] of [
    [['release'], 'liboort_rabitq.so'],
    [['aarch64-apple-darwin', 'release'], 'liboort_rabitq.dylib'],
  ]) {
    fs.mkdirSync(path.join(dir, 'target', ...sub), { recursive: true });
    fs.writeFileSync(path.join(dir, 'target', ...sub, lib), 'binary');
  }
  logs = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pinnedToolchain', () => {
  it('reads the channel the repository pins', () => {
    const channel = pinnedToolchain(path.join(here, '..', 'native'));
    expect(channel).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('fails when the file names no channel', () => {
    fs.writeFileSync(path.join(dir, 'rust-toolchain.toml'), '[toolchain]\nprofile = "minimal"\n');
    expect(() => pinnedToolchain(dir)).toThrow(/no channel/);
  });
});

describe('buildNative', () => {
  it('runs every cargo and rustc call in native/ with the pinned toolchain', () => {
    const { calls, spawn } = fakeRust();
    const result = buildNative(['--require'], { nativeDir: dir, spawn, log });
    expect(result?.out).toBe(path.join(dir, 'oort-rabitq.linux-x64-gnu.node'));
    expect(fs.readFileSync(result.out, 'utf8')).toBe('binary');
    expect(calls.map((c) => c.cmd)).toEqual(['cargo', 'rustc', 'rustc', 'cargo']);
    for (const call of calls) {
      expect(call.cwd).toBe(dir);
      expect(call.toolchain).toBe('1.99.1');
    }
    expect(calls[3].args.slice(0, 2)).toEqual(['build', '--release']);
  });

  it('logs the rustc version it builds with', () => {
    const { spawn } = fakeRust();
    buildNative([], { nativeDir: dir, spawn, log });
    expect(logs).toContain('build-native: rustc 1.99.1 (0123456789 2026-10-29)');
  });

  it('with --pinned-toolchain, stops before building when rustc is another version', () => {
    const { calls, spawn } = fakeRust({ rustcVersion: 'rustc 1.95.0 (abcdef 2026-08-01)' });
    expect(() =>
      buildNative(['--require', '--pinned-toolchain'], { nativeDir: dir, spawn, log }),
    ).toThrow(/rustc 1\.95\.0 .*not the 1\.99\.1 that rust-toolchain\.toml pins/);
    expect(calls.some((c) => c.cmd === 'cargo' && c.args[0] === 'build')).toBe(false);
  });

  it('does not take a version that only starts with the pinned one', () => {
    const { spawn } = fakeRust({ rustcVersion: 'rustc 1.99.10 (abcdef 2027-01-01)' });
    expect(() => buildNative(['--pinned-toolchain'], { nativeDir: dir, spawn, log })).toThrow(
      /not the 1\.99\.1/,
    );
  });

  it('with --pinned-toolchain, builds when rustc matches the file', () => {
    const { spawn } = fakeRust();
    const result = buildNative(['--require', '--pinned-toolchain'], {
      nativeDir: dir,
      spawn,
      log,
    });
    expect(result?.out).toBe(path.join(dir, 'oort-rabitq.linux-x64-gnu.node'));
  });

  it('without --pinned-toolchain, another rustc (one without rustup) still builds', () => {
    const { calls, spawn } = fakeRust({ rustcVersion: 'rustc 1.95.0 (Homebrew)' });
    const result = buildNative([], { nativeDir: dir, spawn, log });
    expect(result?.out).toBeDefined();
    expect(calls.at(-1)?.args[0]).toBe('build');
  });

  it('with --toolchain-only, checks the toolchain and builds nothing', () => {
    const { calls, spawn } = fakeRust();
    const result = buildNative(['--pinned-toolchain', '--toolchain-only'], {
      nativeDir: dir,
      spawn,
      log,
    });
    expect(result).toBeNull();
    expect(calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual([
      'cargo --version',
      'rustc --version',
    ]);
    expect(logs).toContain('build-native: rustc 1.99.1 (0123456789 2026-10-29)');
  });

  it('cross-builds through cargo-zigbuild for --target, in native/ with the pinned toolchain', () => {
    const { calls, spawn } = fakeRust();
    const result = buildNative(['--require', '--zig', '--target', 'aarch64-apple-darwin'], {
      nativeDir: dir,
      spawn,
      log,
    });
    expect(result?.out).toBe(path.join(dir, 'oort-rabitq.darwin-arm64.node'));
    const build = calls.at(-1);
    expect(build?.args[0]).toBe('zigbuild');
    expect(build?.args.slice(-2)).toEqual(['--target', 'aarch64-apple-darwin']);
    expect(build?.cwd).toBe(dir);
    expect(build?.toolchain).toBe('1.99.1');
  });

  it('fails when cargo fails', () => {
    const { spawn } = fakeRust({ buildStatus: 101 });
    expect(() => buildNative(['--require'], { nativeDir: dir, spawn, log })).toThrow(
      /cargo build exited with 101/,
    );
  });

  it('without cargo, skips unless --require', () => {
    const { spawn } = fakeRust({ cargo: false });
    expect(buildNative([], { nativeDir: dir, spawn, log })).toBeNull();
    expect(logs.join('\n')).toMatch(/cargo is not installed/);
    expect(() => buildNative(['--require'], { nativeDir: dir, spawn, log })).toThrow(
      /cargo is not installed/,
    );
  });

  it('--pinned-toolchain implies --require: without cargo, --toolchain-only fails', () => {
    const { spawn } = fakeRust({ cargo: false });
    expect(() =>
      buildNative(['--pinned-toolchain', '--toolchain-only'], { nativeDir: dir, spawn, log }),
    ).toThrow(/cargo is not installed/);
  });

  it('names the pinned toolchain when rustup is there but has not installed it', () => {
    const { spawn } = fakeRust({ cargo: false, rustup: true });
    const missing =
      /Rust 1\.99\.1 \(from native\/rust-toolchain\.toml\) is not installed; run `rustup toolchain install`/;
    expect(buildNative([], { nativeDir: dir, spawn, log })).toBeNull();
    expect(logs.join('\n')).toMatch(missing);
    expect(() => buildNative(['--pinned-toolchain'], { nativeDir: dir, spawn, log })).toThrow(
      missing,
    );
  });
});

describe('build-native.mjs run as a command', () => {
  it('runs when started through a symlinked path', () => {
    const link = path.join(dir, 'store-sqlite');
    fs.symlinkSync(path.join(here, '..'), link, 'dir');
    // No PATH, so no cargo: with --require the script has to fail, which proves it ran.
    const r = spawnSync(
      process.execPath,
      [path.join(link, 'scripts', 'build-native.mjs'), '--require'],
      { cwd: dir, env: { PATH: '' }, encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cargo is not installed/);
  });
});
