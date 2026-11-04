// Builds the Claude Desktop bundle: dist/oort-<platform>-<arch>.mcpb.
//
// The bundle ships the `oortmem` CLI and its dependencies in server/node_modules and runs
// `oort mcp` with the Node.js that ships inside Claude Desktop. better-sqlite3 and sqlite-vec are
// native modules, so a bundle only runs on the platform and architecture it was built on: build
// it on each target (CI builds the macOS ones). Needs `pnpm build` first. No secrets go inside:
// keys are optional user settings that Claude Desktop stores itself.
//
//   node distribution/claude-desktop/build.mjs [--out dist]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const outArg = process.argv.indexOf('--out');
const out = resolve(root, outArg === -1 ? 'dist' : process.argv[outArg + 1]);
const MCPB = '@anthropic-ai/mcpb@2.1.2';

const version = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
const platform = process.platform;
const arch = process.arch;
const stage = join(out, 'mcpb-stage');
const tarballs = join(out, 'mcpb-tarballs');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

rmSync(stage, { recursive: true, force: true });
rmSync(tarballs, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
mkdirSync(tarballs, { recursive: true });

// Pack every publishable package (pnpm turns workspace:* into the real version).
run('pnpm', [
  '-r',
  '--filter',
  './packages/*',
  '--filter',
  '!@oortmem/bench',
  'pack',
  '--pack-destination',
  tarballs,
]);
const packed = readdirSync(tarballs)
  .filter((f) => f.endsWith('.tgz'))
  .map((f) => join(tarballs, f));

// Install them as plain npm packages, production only, into server/node_modules.
writeFileSync(
  join(stage, 'server', 'package.json'),
  JSON.stringify({ name: 'oort-mcpb-server', private: true, type: 'module' }, null, 2),
);
run(
  'npm',
  ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts=false', ...packed],
  {
    cwd: join(stage, 'server'),
  },
);

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'manifest.json'), 'utf8'));
manifest.version = version;
manifest.compatibility.platforms = [platform];
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(import.meta.dirname, 'icon.png'), join(stage, 'icon.png'));

const file = join(out, `oort-${platform}-${arch}.mcpb`);
run('npx', ['-y', MCPB, 'validate', join(stage, 'manifest.json')]);
run('npx', ['-y', MCPB, 'pack', stage, file]);
rmSync(tarballs, { recursive: true, force: true });
console.log(`built ${file}`);
