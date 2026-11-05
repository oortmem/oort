import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { EMBEDDING_DIMENSION, generateMemories } from './generate.js';
import { seedStore } from './seed.js';
import { percentile } from './stats.js';

/**
 * `pnpm --filter @oortmem/bench run bench:serve` (CON-18): the Claude Code hooks' latency with and
 * without `oort serve`, on a synthetic store, using the built CLI (`packages/cli/dist`).
 *
 * For each hook it reports two clocks per run:
 * - `wall`: spawn to exit, as seen from outside (what Claude Code waits for);
 * - `hook`: the hook process's own time from process start to its stdout being flushed
 *   (`OORT_HOOK_TIMING=1`), which leaves out process teardown.
 * It also reports Node's own startup (`node -e 0`) as the floor of any hook process, and the
 * daemon's side alone: one `hook` request on the socket, connect to answer, from a warm client.
 *
 * No keys are set and the keychain is off, so recall is lexical-only: the numbers are Oort's
 * local overhead, without any network call to an embedder or reranker.
 */

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    runs: { type: 'string', default: '40' },
    count: { type: 'string', default: '2000' },
    json: { type: 'boolean', default: false },
  },
});
const RUNS = Number(values.runs);
const COUNT = Number(values.count);
const WARMUP = 3;

const CLI_DIST = path.resolve(import.meta.dirname, '..', '..', 'cli', 'dist');
const BIN = path.join(CLI_DIST, 'main.js');
if (!fs.existsSync(BIN)) {
  process.stderr.write(`bench:serve: ${BIN} is missing; run \`pnpm build\` first.\n`);
  process.exit(2);
}

interface Client {
  callDaemon(
    socket: string,
    method: string,
    params: Record<string, unknown>,
    opts?: { budgetMs?: number; connectTimeoutMs?: number },
  ): Promise<{ ok: boolean; result?: Record<string, unknown> }>;
}
interface Protocol {
  socketPathFor(home: string): string;
  cliVersion(): string;
}
const client = (await import(pathToFileURL(path.join(CLI_DIST, 'serve-client.js')).href)) as Client;
const protocol = (await import(
  pathToFileURL(path.join(CLI_DIST, 'serve-protocol.js')).href
)) as Protocol;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oort-serve-bench-')));
const home = path.join(root, 'home');
const oortHome = path.join(home, '.oort');
const cwd = path.join(root, 'work');
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const env = {
  PATH: process.env['PATH'] ?? '',
  HOME: home,
  OORT_HOME: oortHome,
  OORT_NO_KEYCHAIN: '1',
  OORT_HOOK_TIMING: '1',
};
const socket = protocol.socketPathFor(oortHome);

// The synthetic store: COUNT memories, the newest 50 global ones hot (SessionStart injects them).
const memories = generateMemories(COUNT, 7);
const global = memories.filter((m) => m.scope.projectId === undefined);
for (const m of global.slice(-50)) m.tier = 'hot';
const store = await openSqliteStore({
  path: path.join(oortHome, 'oort.sqlite'),
  coldDir: path.join(oortHome, 'cold'),
  dimension: EMBEDDING_DIMENSION,
  log: () => {},
});
await seedStore(store, memories);
await store.close();

/** Prompts that hit global memories: a question about one memory's own words. */
const prompts = global
  .filter((_m, i) => i % Math.max(1, Math.floor(global.length / 40)) === 0)
  .map((m) => `what did we decide about ${m.text.split(/\s+/).slice(0, 6).join(' ')}?`);

interface Sample {
  wallMs: number;
  hookMs: number;
  via: string;
  injected: boolean;
}

function runHook(event: string, input: string): Promise<Sample> {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(BIN, ['hook', event], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', () => {
      const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const m = /oort-hook \S+ via=(\w+) ([\d.]+)ms/.exec(stderr);
      resolve({
        wallMs,
        hookMs: m === null ? NaN : Number(m[2]),
        via: m?.[1] ?? '?',
        injected: stdout.includes('additionalContext'),
      });
    });
    child.stdin.end(input);
  });
}

const inputFor = (event: string, i: number): string =>
  event === 'UserPromptSubmit'
    ? JSON.stringify({ session_id: 'bench', cwd, prompt: prompts[i % prompts.length] })
    : JSON.stringify({ session_id: 'bench', cwd, source: 'startup' });

async function series(event: string): Promise<Sample[]> {
  for (let i = 0; i < WARMUP; i++) await runHook(event, inputFor(event, i));
  const out: Sample[] = [];
  for (let i = 0; i < RUNS; i++) out.push(await runHook(event, inputFor(event, i)));
  return out;
}

const stats = (xs: number[]): { p50: number; p95: number } => ({
  p50: Math.round(percentile(xs, 50) * 10) / 10,
  p95: Math.round(percentile(xs, 95) * 10) / 10,
});

function nodeFloor(): { wall: { p50: number; p95: number }; boot: { p50: number; p95: number } } {
  const wall: number[] = [];
  const boot: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(performance.now()))'],
      {
        encoding: 'utf8',
      },
    );
    wall.push(Number(process.hrtime.bigint() - t0) / 1e6);
    boot.push(Number(r.stdout));
  }
  return { wall: stats(wall), boot: stats(boot) };
}

const results: Record<string, unknown> = {
  node: process.version,
  platform: `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? ''}`.trim(),
  memories: COUNT,
  runs: RUNS,
  nodeFloor: nodeFloor(),
};

for (const event of ['UserPromptSubmit', 'SessionStart']) {
  const s = await series(event);
  results[`${event}.inProcess`] = {
    wall: stats(s.map((x) => x.wallMs)),
    hook: stats(s.map((x) => x.hookMs)),
    via: [...new Set(s.map((x) => x.via))],
    injected: s.filter((x) => x.injected).length,
  };
}

const daemon = spawn(BIN, ['serve', '--idle', '10m'], { cwd, env, stdio: 'ignore' });
try {
  const until = Date.now() + 10_000;
  while (!(await client.callDaemon(socket, 'ping', {}, { budgetMs: 300 })).ok) {
    if (Date.now() > until) throw new Error('oort serve did not start');
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    const s = await series(event);
    // The daemon alone: one request from a warm client, connect to answer.
    const side: number[] = [];
    for (let i = 0; i < RUNS + WARMUP; i++) {
      const t0 = process.hrtime.bigint();
      const r = await client.callDaemon(socket, 'hook', {
        event,
        stdin: inputFor(event, i),
        cwd,
        version: protocol.cliVersion(),
      });
      if (!r.ok) throw new Error(`daemon request failed for ${event}`);
      if (i >= WARMUP) side.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    results[`${event}.daemon`] = {
      wall: stats(s.map((x) => x.wallMs)),
      hook: stats(s.map((x) => x.hookMs)),
      via: [...new Set(s.map((x) => x.via))],
      injected: s.filter((x) => x.injected).length,
      daemonSide: stats(side),
    };
  }
} finally {
  daemon.kill('SIGTERM');
  await new Promise((r) => daemon.once('exit', r));
  fs.rmSync(root, { recursive: true, force: true });
}

if (values.json) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  const floor = results['nodeFloor'] as ReturnType<typeof nodeFloor>;
  const lines = [
    `# oort serve bench (${results['memories']} memories, ${RUNS} runs each, ${results['node']}, ${results['platform']})`,
    '',
    '| hook | mode | wall p50 | wall p95 | hook p50 | hook p95 | daemon side p50 | daemon side p95 | injected |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    for (const mode of ['inProcess', 'daemon'] as const) {
      const r = results[`${event}.${mode}`] as {
        wall: { p50: number; p95: number };
        hook: { p50: number; p95: number };
        daemonSide?: { p50: number; p95: number };
        injected: number;
      };
      lines.push(
        `| ${event} | ${mode === 'daemon' ? 'with oort serve' : 'in-process'} | ${r.wall.p50} | ${r.wall.p95} | ${r.hook.p50} | ${r.hook.p95} | ${r.daemonSide?.p50 ?? '-'} | ${r.daemonSide?.p95 ?? '-'} | ${r.injected}/${RUNS} |`,
      );
    }
  }
  lines.push(
    '',
    `Node alone (\`node -e 0\`): wall p50 ${floor.wall.p50} ms, p95 ${floor.wall.p95} ms; user code starts at p50 ${floor.boot.p50} ms after process start.`,
    'All times in ms. wall: spawn to exit. hook: process start to stdout flushed. daemon side: one socket request from a warm client.',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}
