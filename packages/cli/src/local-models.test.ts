/**
 * Local models end to end through the real CLI (CON-15): opt-in pull with checksums, recall
 * and the prompt hook on the CPU, the embedder binding and `oort reembed`, doctor, and undo.
 * The models are the tiny fixtures from @oortmem/local-models (a few kB, real ONNX Runtime),
 * added to the catalog for the test; downloads go through an injected fetch.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqliteStore, readEmbedderBinding } from '@oortmem/store-sqlite';
import { TG } from '@oortmem/core/store-conformance';
import { createKeychain } from './keychain.js';
import { runCli } from './program.js';
import { fakeIo, memory, tmpdir, type FakeIo, data } from '../test/helpers.js';
import { fixtureFetch, registerTinyModels } from '../test/local-models.js';

let unregister: () => void;
beforeAll(() => {
  unregister = registerTinyModels();
});
afterAll(() => unregister());

interface Sandbox {
  home: string;
  oortHome: string;
  cwd: string;
  calls: string[];
}

function sandbox(): Sandbox {
  const home = tmpdir('oort-local-');
  const s = { home, oortHome: path.join(home, '.oort'), cwd: path.join(home, 'work'), calls: [] };
  fs.mkdirSync(s.cwd);
  return s;
}

async function oort(
  s: Sandbox,
  args: string[],
  opts: { stdin?: string } = {},
): Promise<{ code: number; io: FakeIo }> {
  const io = fakeIo({
    cwd: s.cwd,
    env: {
      HOME: s.home,
      OORT_HOME: s.oortHome,
      OORT_NO_KEYCHAIN: '1',
      OORT_MODELS_URL: 'https://models.example',
    },
    ...(opts.stdin !== undefined && { stdin: opts.stdin }),
  });
  const code = await runCli(args, io, undefined, createKeychain({ platform: 'none' }), {
    fetch: fixtureFetch(s.calls),
  });
  return { code, io };
}

const BACKUPS = 'database backups are retained for 35 days';
const VITEST = 'we use vitest for tests';

/** Two memories as an older Oort wrote them: Voyage-shaped vectors, no binding recorded. */
async function seedVoyageStore(s: Sandbox): Promise<void> {
  const store = await openSqliteStore({
    path: path.join(s.oortHome, 'oort.sqlite'),
    coldDir: path.join(s.oortHome, 'cold'),
    dimension: 512,
    log: () => {},
  });
  await store.upsertMany(TG, [
    memory({ text: BACKUPS, embedding: new Int8Array(512).fill(3) }),
    memory({ text: VITEST, embedding: new Int8Array(512).fill(-3) }),
  ]);
  await store.close();
}

const config = (s: Sandbox): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(s.oortHome, 'config.json'), 'utf8')) as Record<
    string,
    unknown
  >;

describe('local models are opt-in', () => {
  it('local.chosen-but-not-pulled-stays-lexical-and-downloads-nothing', async () => {
    const s = sandbox();
    await seedVoyageStore(s);
    fs.writeFileSync(
      path.join(s.oortHome, 'config.json'),
      JSON.stringify({ embed: { provider: 'local', model: 'tiny-embed' } }),
    );
    const r = await oort(s, ['recall', 'how long are database backups kept']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toContain('35 days');
    expect(r.io.stderr).toContain('lexical-only');
    expect(r.io.stderr).toContain('oort models pull tiny-embed');
    expect(s.calls).toEqual([]);
    expect(fs.existsSync(path.join(s.oortHome, 'models'))).toBe(false);
  });

  it('local.pull-verifies-switches-config-and-reports-the-store-mismatch', async () => {
    const s = sandbox();
    await seedVoyageStore(s);
    const pull = await oort(s, ['models', 'pull', 'tiny-embed', 'tiny-rerank']);
    expect(pull.code, pull.io.stderr).toBe(0);
    expect(
      s.calls.every((u) => u.startsWith('https://models.example/oort/tiny/resolve/test/')),
    ).toBe(true);
    expect(s.calls).toHaveLength(6);
    expect(pull.io.stdout).toContain('verified');
    expect(pull.io.stdout).toContain('oort reembed');
    expect(config(s)).toMatchObject({
      embed: { provider: 'local', model: 'tiny-embed' },
      rerank: { provider: 'local', model: 'tiny-rerank' },
    });
    const list = await oort(s, ['models', 'list', '--json']);
    const rows = (
      data(list.io.stdout) as { models: { id: string; state: string; active: boolean }[] }
    ).models;
    expect(rows.find((m) => m.id === 'tiny-embed')).toMatchObject({ state: 'ready', active: true });
    expect(rows.find((m) => m.id === 'bge-small-en-v1.5')).toMatchObject({
      state: 'missing',
      active: false,
    });
  });

  it('local.pull-refuses-a-tampered-download', async () => {
    const s = sandbox();
    const io = fakeIo({
      cwd: s.cwd,
      env: { HOME: s.home, OORT_HOME: s.oortHome, OORT_NO_KEYCHAIN: '1' },
    });
    const tampered = (async (input: string | URL | Request) => {
      const res = await fixtureFetch(s.calls)(input);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length > 0) data[0] = data[0]! ^ 0xff;
      return new Response(data, { status: res.status });
    }) as typeof fetch;
    const code = await runCli(
      ['models', 'pull', 'tiny-embed'],
      io,
      undefined,
      createKeychain({ platform: 'none' }),
      {
        fetch: tampered,
      },
    );
    expect(code).toBe(2);
    expect(io.stderr).toContain('failed verification');
    expect(fs.existsSync(path.join(s.oortHome, 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(s.oortHome, 'models', 'tiny-embed', 'oort-model.json'))).toBe(
      false,
    );
  });
});

describe('a store embedded with another model', () => {
  const s = sandbox();
  beforeAll(async () => {
    await seedVoyageStore(s);
    expect((await oort(s, ['models', 'pull', 'tiny-embed', 'tiny-rerank'])).code).toBe(0);
  });
  afterAll(() => fs.rmSync(s.home, { recursive: true, force: true }));

  it('local.mismatch-turns-dense-off-and-doctor-says-reembed', async () => {
    const r = await oort(s, ['recall', 'how long are database backups kept']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toContain('35 days');
    expect(r.io.stderr).toContain('embedded with voyage/voyage-3.5-lite');
    expect(r.io.stderr).toContain('oort reembed');
    expect(readEmbedderBinding(path.join(s.oortHome, 'oort.sqlite')).model).toBe(
      'voyage/voyage-3.5-lite',
    );
    const doctor = await oort(s, ['doctor', '--json']);
    const checks = (
      data(doctor.io.stdout) as {
        checks: { name: string; status: string; fix?: string; detail: string }[];
      }
    ).checks;
    expect(checks.find((c) => c.name === 'embedder')).toMatchObject({
      status: 'warn',
      fix: 'oort reembed',
    });
    expect(checks.find((c) => c.name === 'embed')).toMatchObject({ status: 'ok' });
    expect(checks.find((c) => c.name === 'embed')?.detail).toContain('local model tiny-embed');
  });

  it('local.reembed-moves-the-store-and-recall-goes-dense', async () => {
    const re = await oort(s, ['reembed']);
    expect(re.code, re.io.stderr).toBe(0);
    expect(re.io.stdout).toContain('re-embedded 2 memories');
    expect(readEmbedderBinding(path.join(s.oortHome, 'oort.sqlite')).model).toBe(
      'local/tiny-embed',
    );
    const again = await oort(s, ['reembed']);
    expect(again.io.stdout).toContain('nothing to do');

    const r = await oort(s, ['recall', 'how long are database backups kept', '--json']);
    expect(r.code).toBe(0);
    expect(r.io.stderr).not.toContain('lexical-only');
    expect(r.io.stdout).toContain('35 days');
    const doctor = await oort(s, ['doctor', '--json']);
    const checks = (data(doctor.io.stdout) as { checks: { name: string; status: string }[] })
      .checks;
    expect(checks.find((c) => c.name === 'embedder')).toMatchObject({ status: 'ok' });
  });

  it('local.prompt-hook-embeds-locally-without-the-local-reranker', async () => {
    const r = await oort(s, ['hook', 'UserPromptSubmit'], {
      stdin: JSON.stringify({
        session_id: 's-local',
        cwd: s.cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'how long do we keep database backups?',
      }),
    });
    expect(r.code).toBe(0);
    expect(r.io.hookStdout ?? '').toContain('35 days');
    const log = fs
      .readFileSync(path.join(s.oortHome, 'logs', 'hooks.log'), 'utf8')
      .trim()
      .split('\n');
    const entry = JSON.parse(log.at(-1)!) as {
      degraded?: string[];
      timings: Record<string, number>;
    };
    expect(entry.degraded).toContain('no-reranker');
    expect(entry.degraded ?? []).not.toContain('no-embedder');
  });

  it('local.rm-deletes-the-models-and-switches-back', async () => {
    const r = await oort(s, ['models', 'rm']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(s.oortHome, 'models', 'tiny-embed'))).toBe(false);
    expect(config(s)).toEqual({});
    expect(r.io.stdout).toContain('oort reembed'); // the store is now bound to the local model
  });
});

describe('setup', () => {
  it('local.setup-keys-local-continues-when-the-download-fails', async () => {
    const s = sandbox();
    const r = await oort(s, ['setup', '--yes', '--agents', 'none', '--keys', 'local', '--no-demo']);
    expect(r.code, r.io.stderr).toBe(0);
    // The fixture server has no bge-small: the pull fails, setup says so and goes on.
    expect(r.io.stdout).toContain('Local models skipped');
    expect(r.io.stdout).toContain('HTTP 404');
    expect(s.calls[0]).toContain('/Xenova/bge-small-en-v1.5/resolve/');
  });

  it('local.setup-rejects-an-unknown-keys-mode', async () => {
    const s = sandbox();
    const r = await oort(s, ['setup', '--yes', '--keys', 'nope']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('byo, pro, local or skip');
  });
});
