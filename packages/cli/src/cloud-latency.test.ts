import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeCloud, fakeMemory, type FakeCloud } from '../test/fake-cloud.js';
import { tmpdir } from '../test/helpers.js';
import { callDaemon } from './serve-client.js';
import { socketPathFor } from './serve-protocol.js';

/**
 * The prompt hook in cloud mode, as real processes against a local Oort Cloud (CON-101): the
 * daemon's keep-alive connection, `OORT_HOOK_TIMING=1`, long prompts and `recall.promptMode`.
 */

const BIN = path.join(import.meta.dirname, '..', 'dist', 'main.js');

/** Assembled at runtime so no key literal sits in a source file. */
const oortKey = ['oort', 'sk', 'latency'.padEnd(43, 'L')].join('_');

interface LocalCloud {
  url: string;
  cloud: FakeCloud;
  connections: () => number;
  paths: string[];
  timingHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/** The fake cloud behind a real HTTP server, with /health and Server-Timing when asked. */
async function localCloud(): Promise<LocalCloud> {
  const cloud = fakeCloud(oortKey);
  let connections = 0;
  const paths: string[] = [];
  const timingHeaders: (string | undefined)[] = [];
  const srv = http.createServer(async (req, res) => {
    paths.push(req.url ?? '');
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const timing = req.headers['x-oort-timing'];
    timingHeaders.push(typeof timing === 'string' ? timing : undefined);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const r = await cloud.fetch(`https://api.oortcloud.dev${req.url}`, {
      method: req.method ?? 'GET',
      headers,
      ...(chunks.length > 0 && { body: Buffer.concat(chunks) }),
    });
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    if (timing === '1') res.setHeader('server-timing', 'auth;dur=41, do;dur=700, total;dur=760');
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  srv.keepAliveTimeout = 120_000;
  srv.on('connection', () => connections++);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    cloud,
    connections: () => connections,
    paths,
    timingHeaders,
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}

interface Sandbox {
  home: string;
  oortHome: string;
  cwd: string;
  env: Record<string, string>;
}

function sandbox(cloud: LocalCloud): Sandbox {
  const root = tmpdir('oort-latency-');
  const home = path.join(root, 'home');
  const oortHome = path.join(home, '.oort');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(oortHome, { recursive: true });
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(oortHome, 'cloud.json'), '{"store":"cloud"}\n');
  return {
    home,
    oortHome,
    cwd,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      OORT_HOME: oortHome,
      OORT_NO_KEYCHAIN: '1',
      OORT_API_KEY: oortKey,
      OORT_CLOUD_URL: cloud.url,
    },
  };
}

const prompt = (s: Sandbox, text: string): string =>
  JSON.stringify({
    session_id: 's-latency',
    cwd: s.cwd,
    hook_event_name: 'UserPromptSubmit',
    prompt: text,
  });

const hook = (s: Sandbox, text: string, env: Record<string, string> = {}) =>
  execa(BIN, ['hook', 'UserPromptSubmit'], {
    cwd: s.cwd,
    env: { ...s.env, ...env },
    extendEnv: false,
    reject: false,
    timeout: 20_000,
    input: prompt(s, text),
  });

/** The `oort-timing` line's numbers (and `via`). */
function timingOf(stderr: string): Record<string, unknown> | undefined {
  const m = /^oort-timing (\{.*\})$/m.exec(stderr);
  return m === null ? undefined : (JSON.parse(m[1]!) as Record<string, unknown>);
}

const children: ChildProcess[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const c of closers.splice(0)) await c();
});

beforeAll(() => {
  if (!fs.existsSync(BIN)) throw new Error(`${BIN} is missing: run \`pnpm build\` first`);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startServe(s: Sandbox): Promise<ChildProcess> {
  const child = spawn(BIN, ['serve'], { cwd: s.cwd, env: s.env, stdio: 'ignore' });
  children.push(child);
  const socket = socketPathFor(s.oortHome);
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if ((await callDaemon(socket, 'ping', {}, { budgetMs: 300 })).ok) return child;
    await sleep(50);
  }
  throw new Error('oort serve did not start');
}

const FACT = 'The auth service listens on port 8443 behind the gateway.';

describe('the prompt hook in cloud mode (CON-101)', () => {
  it(
    'cloud-latency.the-daemon-keeps-one-connection-open-across-prompts',
    { timeout: 30_000 },
    async () => {
      const c = await localCloud();
      closers.push(c.close);
      c.cloud.memories.set('m1', fakeMemory({ id: 'm1', text: FACT }));
      const s = sandbox(c);
      await startServe(s);
      // Listening, the daemon opens its connection at once (GET /health: no key, nothing read).
      const end = Date.now() + 5000;
      while (!c.paths.includes('/health') && Date.now() < end) await sleep(20);
      expect(c.paths[0]).toBe('/health');

      const first = await hook(s, 'which port does the auth service listen on?', {
        OORT_HOOK_TIMING: '1',
      });
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain('8443');
      // Longer than the global fetch keeps an idle connection (4 s): the pool keeps it.
      await sleep(4500);
      const second = await hook(s, 'and which gateway is the auth service behind?', {
        OORT_HOOK_TIMING: '1',
      });
      expect(second.stdout).toContain('8443');
      // One TCP connection for the warm-up and both recalls.
      expect(c.paths.filter((p) => p === '/v1/recall')).toHaveLength(2);
      expect(c.connections()).toBe(1);
      const t = timingOf(second.stderr);
      expect(t?.['via']).toBe('daemon');
      expect(t?.['cloudConnected']).toBe(0);
      for (const k of ['cloudMs', 'cloudHeadersMs', 'recallMs', 'socketMs']) {
        expect(t?.[k], k).toBeTypeOf('number');
      }
      // The daemon was not started with OORT_HOOK_TIMING: it never asks the API for Server-Timing.
      expect(c.timingHeaders).toEqual([undefined, undefined]);
      // Numbers only: never the prompt or a memory.
      expect(second.stderr).not.toContain('8443');
      expect(second.stderr).not.toContain('gateway');
    },
  );

  it('cloud-latency.in-process-timing-asks-for-server-timing', async () => {
    const c = await localCloud();
    closers.push(c.close);
    c.cloud.memories.set('m1', fakeMemory({ id: 'm1', text: FACT }));
    const s = sandbox(c);
    const plain = await hook(s, 'which port does the auth service listen on?');
    expect(plain.stdout).toContain('8443');
    expect(timingOf(plain.stderr)).toBeUndefined();
    const timed = await hook(s, 'which port does the auth service listen on?', {
      OORT_HOOK_TIMING: '1',
    });
    expect(timed.stdout).toBe(plain.stdout);
    expect(c.timingHeaders).toEqual([undefined, '1']);
    const t = timingOf(timed.stderr);
    expect(t?.['via']).toBe('process');
    expect(t?.['cloudConnected']).toBe(1);
    expect(t?.['cloudTcpMs']).toBeTypeOf('number');
    expect(t?.['serverAuthMs']).toBe(41);
    expect(t?.['serverDoMs']).toBe(700);
  });

  it('cloud-latency.a-long-prompt-still-recalls', async () => {
    const c = await localCloud();
    closers.push(c.close);
    c.cloud.memories.set('m1', fakeMemory({ id: 'm1', text: FACT }));
    const s = sandbox(c);
    const pasted = `${'2026-11-05T10:00:00Z GET /v1/recall 200 812ms\n'.repeat(120)}which port does the auth service listen on?`;
    const r = await hook(s, pasted);
    expect(r.stdout).toContain('8443');
    const sent = c.cloud.recalls.at(-1)?.['text'] as string;
    expect(new TextEncoder().encode(sent).byteLength).toBeLessThanOrEqual(2048);
    expect(sent.endsWith('which port does the auth service listen on?')).toBe(true);
  });

  it('cloud-latency.prompt-mode-asks-the-api-to-skip-stages', async () => {
    const c = await localCloud();
    closers.push(c.close);
    const s = sandbox(c);
    // The default is `fast` since 0.5.3: embed, no rerank.
    await hook(s, 'which port does the auth service listen on?');
    fs.writeFileSync(path.join(s.oortHome, 'config.json'), '{"recall":{"promptMode":"lexical"}}\n');
    await hook(s, 'which port does the auth service listen on?');
    fs.writeFileSync(path.join(s.oortHome, 'config.json'), '{"recall":{"promptMode":"full"}}\n');
    await hook(s, 'which port does the auth service listen on?');
    expect(c.cloud.recalls.map((b) => [b['rerank'], b['embed']])).toEqual([
      [false, undefined],
      [false, false],
      [undefined, undefined],
    ]);
  });
});
