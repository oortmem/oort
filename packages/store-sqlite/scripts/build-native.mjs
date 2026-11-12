// Builds the native RaBitQ engine (native/, Rust through napi-rs) for this machine, or for
// `--target <rust triple>`, and copies it to native/oort-rabitq.<platform tag>.node, where
// src/rabitq.ts looks for it. Needs cargo; without it, prints why and exits 0 unless --require,
// since the store falls back to the TypeScript engine.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const native = path.join(here, '..', 'native');
const args = process.argv.slice(2);
const require = args.includes('--require');
const ti = args.indexOf('--target');
const target = ti >= 0 ? args[ti + 1] : undefined;

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

if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) {
  const msg = 'build-native: cargo is not installed; the store will use the TypeScript engine';
  if (require) throw new Error(msg);
  console.log(msg);
  process.exit(0);
}
const host = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
const triple = target ?? host;
execFileSync(
  'cargo',
  [
    'build',
    '--release',
    '--locked',
    '--features',
    'node',
    '--manifest-path',
    path.join(native, 'Cargo.toml'),
    ...(target !== undefined ? ['--target', target] : []),
  ],
  { stdio: 'inherit' },
);
const lib = { darwin: 'liboort_rabitq.dylib', linux: 'liboort_rabitq.so' }[
  triple.includes('apple') ? 'darwin' : 'linux'
];
const built = path.join(
  native,
  'target',
  ...(target !== undefined ? [target] : []),
  'release',
  lib,
);
const out = path.join(native, `oort-rabitq.${tagOf(triple)}.node`);
// Copy, then rename over the old file: a process that has the old one loaded keeps its inode
// (on macOS, rewriting a loaded binary in place gets that process killed).
fs.copyFileSync(built, `${out}.tmp`);
fs.renameSync(`${out}.tmp`, out);
console.log(`build-native: ${path.relative(process.cwd(), out)}`);
