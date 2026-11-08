// Fails unless every publishable package in packages/*, core's VERSION, every plugin and
// marketplace manifest, the MCPB manifest, the MCP Registry server.json, the Python launcher and
// the skills under skills/ equal the given version.
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
// Every plugin either marketplace lists, so a new plugin is checked as soon as it is listed.
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const plugins = [
  ...json('.claude-plugin/marketplace.json').plugins.map(
    (e) => `${e.source.replace(/^\.\//, '')}/.claude-plugin/plugin.json`,
  ),
  ...json('.agents/plugins/marketplace.json').plugins.map(
    (e) => `${e.source.path}/.codex-plugin/plugin.json`,
  ),
];
for (const file of [
  ...plugins,
  'distribution/claude-desktop/manifest.json',
  '.claude-plugin/marketplace.json',
]) {
  const v = json(file).version;
  if (v !== want) bad.push(`${file} is ${v}`);
}
// The MCP Registry entry (server.json) names the release and the oortmem package version it runs.
const server = json('server.json');
if (server.version !== want) bad.push(`server.json is ${server.version}`);
for (const p of server.packages ?? []) {
  if (p.version !== want) bad.push(`server.json package ${p.identifier} is ${p.version}`);
}
// A skill for building with Oort names the release it describes (skills/<name>/SKILL.md).
for (const e of readdirSync('skills', { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const file = join('skills', e.name, 'SKILL.md');
  const v = readFileSync(file, 'utf8').match(/^ {2}oortmem-version: ['"]?([^'"\n]+)['"]?$/m);
  if (v?.[1] !== want) bad.push(`${file} metadata.oortmem-version is ${v?.[1] ?? 'missing'}`);
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
