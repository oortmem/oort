// Builds the native RaBitQ engine (native/, Rust through napi-rs) for this machine, or for
// `--target <rust triple>`, and copies it to native/oort-rabitq.<platform tag>.node, where
// src/rabitq.ts looks for it. Needs cargo; without it, prints why and exits 0 unless --require,
// since the store falls back to the TypeScript engine. `--zig` builds through cargo-zigbuild (zig
// links), which is how the release workflow cross-compiles aarch64-apple-darwin on Linux.
//
// Every cargo and rustc call runs in native/ with RUSTUP_TOOLCHAIN set to the channel
// native/rust-toolchain.toml pins, so rustup builds with that toolchain wherever this script is
// started from. A cargo and rustc without rustup (Homebrew's, say) ignore both. The script prints
// `rustc --version` before building; `--pinned-toolchain` makes a different version an error (CI and
// release use it) and implies --require, and `--toolchain-only` stops after that check.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The tag of a Rust target triple, as `nativePlatformTag()` names the running platform. */
function tagOf(triple) {
  const known = {
    'aarch64-apple-darwin': 'darwin-arm64',
    'x86_64-apple-darwin': 'darwin-x64',
    'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
    'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
  };
  const tag = known[triple];
  if (tag === undefined) throw new Error(`build-native: no platform tag for ${triple}`);
  return tag;
}

/** The `channel` that `<nativeDir>/rust-toolchain.toml` pins, such as `1.99.1`. */
export function pinnedToolchain(nativeDir) {
  const file = path.join(nativeDir, 'rust-toolchain.toml');
  const channel = /^\s*channel\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
  if (channel === undefined) throw new Error(`build-native: ${file} names no channel`);
  return channel;
}

/**
 * Builds the engine as the command line `args` asks, and returns `{ out }`, the path of the
 * copied binary, or null when it built nothing (no cargo without --require, or
 * --toolchain-only). `spawn` has spawnSync's signature; tests pass a stand-in.
 */
export function buildNative(
  args,
  { nativeDir = path.join(here, '..', 'native'), spawn = spawnSync, log = console.log } = {},
) {
  const pinned = args.includes('--pinned-toolchain');
  const require = pinned || args.includes('--require');
  const zig = args.includes('--zig');
  const toolchainOnly = args.includes('--toolchain-only');
  const ti = args.indexOf('--target');
  const target = ti >= 0 ? args[ti + 1] : undefined;

  const channel = pinnedToolchain(nativeDir);
  const opts = { cwd: nativeDir, env: { ...process.env, RUSTUP_TOOLCHAIN: channel } };
  /** Runs a command for its output, failing unless it exits 0. */
  const output = (cmd, cmdArgs) => {
    const r = spawn(cmd, cmdArgs, { ...opts, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`build-native: ${cmd} ${cmdArgs.join(' ')} exited with ${r.status}`);
    }
    return r.stdout;
  };

  if (spawn('cargo', ['--version'], { ...opts, stdio: 'ignore' }).status !== 0) {
    // With rustup on PATH, cargo fails here because the pinned toolchain is not installed.
    const rustup = spawn('rustup', ['--version'], { stdio: 'ignore' }).error === undefined;
    const missing = rustup
      ? `Rust ${channel} (from native/rust-toolchain.toml) is not installed; ` +
        'run `rustup toolchain install` in native/'
      : 'cargo is not installed';
    const msg = `build-native: ${missing}; the store will use the TypeScript engine`;
    if (require) throw new Error(msg);
    log(msg);
    return null;
  }
  const version = output('rustc', ['--version']).trim();
  log(`build-native: ${version}`);
  if (pinned && !version.startsWith(`rustc ${channel} `)) {
    throw new Error(
      `build-native: ${version} is not the ${channel} that rust-toolchain.toml pins ` +
        '(install it with `rustup toolchain install` in native/)',
    );
  }
  if (toolchainOnly) return null;

  const host = /host: (\S+)/.exec(output('rustc', ['-vV']))?.[1];
  const triple = target ?? host;
  const subcommand = zig ? 'zigbuild' : 'build';
  const build = spawn(
    'cargo',
    [
      subcommand,
      '--release',
      '--locked',
      '--features',
      'node',
      '--manifest-path',
      path.join(nativeDir, 'Cargo.toml'),
      ...(target !== undefined ? ['--target', target] : []),
    ],
    { ...opts, stdio: 'inherit' },
  );
  if (build.status !== 0) {
    throw new Error(`build-native: cargo ${subcommand} exited with ${build.status}`);
  }
  const lib = { darwin: 'liboort_rabitq.dylib', linux: 'liboort_rabitq.so' }[
    triple.includes('apple') ? 'darwin' : 'linux'
  ];
  const built = path.join(
    nativeDir,
    'target',
    ...(target !== undefined ? [target] : []),
    'release',
    lib,
  );
  const out = path.join(nativeDir, `oort-rabitq.${tagOf(triple)}.node`);
  // Copy, then rename over the old file: a process that has the old one loaded keeps its inode
  // (on macOS, rewriting a loaded binary in place gets that process killed).
  fs.copyFileSync(built, `${out}.tmp`);
  fs.renameSync(`${out}.tmp`, out);
  log(`build-native: ${path.relative(process.cwd(), out)}`);
  return { out };
}

// Real paths on both sides: started through a symlink, argv[1] keeps the link while Node
// resolves import.meta.url to the file it points at.
if (
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  buildNative(process.argv.slice(2));
}
