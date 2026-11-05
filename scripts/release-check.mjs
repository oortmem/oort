// Fails unless every publishable package in packages/* and core's VERSION equal the given version.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const want = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(want ?? '')) {
  console.error(`release-check: "${want}" is not a version (tag must be vX.Y.Z)`);
  process.exit(1);
}
const bad = [];
for (const dir of readdirSync('packages')) {
  const pkg = JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'));
  if (pkg.private) continue;
  if (pkg.version !== want) bad.push(`${pkg.name} is ${pkg.version}`);
}
for (const file of [
  'distribution/claude-code/oort/.claude-plugin/plugin.json',
  'distribution/codex/oort/.codex-plugin/plugin.json',
  'distribution/claude-desktop/manifest.json',
  '.claude-plugin/marketplace.json',
]) {
  const v = JSON.parse(readFileSync(file, 'utf8')).version;
  if (v !== want) bad.push(`${file} is ${v}`);
}
// The Python launcher (python/) pins the npm release it runs, so it moves in lockstep.
const py = readFileSync('python/pyproject.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
if (py?.[1] !== want) bad.push(`python/pyproject.toml is ${py?.[1] ?? 'missing'}`);
const pyInit = readFileSync('python/src/oortmem/__init__.py', 'utf8').match(
  /__version__\s*=\s*"([^"]+)"/,
);
if (pyInit?.[1] !== want) bad.push(`python __version__ is ${pyInit?.[1] ?? 'missing'}`);
const core = readFileSync('packages/core/src/index.ts', 'utf8').match(/VERSION\s*=\s*'([^']+)'/);
if (core?.[1] !== want) bad.push(`core VERSION is ${core?.[1] ?? 'missing'}`);
if (bad.length) {
  console.error(`release-check: tag v${want} does not match:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`release-check: every package is ${want}`);
