import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MissingCredentialError, localScope, type DecisionController } from '@oortmem/core';
import { TG } from '@oortmem/core/store-conformance';
import { openSqliteStore } from '@oortmem/store-sqlite';
import {
  JSON_NEVER_ASKS,
  NO_TTY_STDIN,
  PIPED_YES,
  expectAsked,
  expectDeclined,
  expectRefusedWithoutPrompt,
  fakeDecide,
  fakeEmbedder,
  harness,
  memory,
  memoryKeychain,
  writeTranscript,
  type Harness,
  data,
} from '../test/helpers.js';
import { createKeychain } from './keychain.js';
import { adapterProblem, remedySentence } from './util.js';

/**
 * CON-107 step 1: prompts never on stdout, one missing-key remedy, exit codes as docs/cli.md
 * says, consistent human output, and `safeJson` wherever memory text reaches `--json`.
 */

/** A right-to-left override and a C1 CSI: what `safeJson` must escape. Built from escapes. */
const RLO = '\u202e';
const CSI = '\u009b';
const HOSTILE = `deploy with ${RLO}gnp.exe${CSI}31m on Tuesday`;

/** JSON that parses back to `text` but carries neither raw character. */
function expectEscaped(stdout: string): void {
  expect(stdout).not.toContain(RLO);
  expect(stdout).not.toContain(CSI);
  expect(stdout).toContain('\\u202e');
  expect(stdout).toContain('\\u009b');
  expect(JSON.stringify(JSON.parse(stdout))).toContain(JSON.stringify(HOSTILE).slice(1, -1));
}

const terminal = { tty: true, stdoutTTY: true, answer: 'n' } as const;

/** A store bound to a local embedder while the config names a paid one: reembed asks first. */
function needsPaidReembed(h: Harness): void {
  const base = h.wire;
  h.wire = async (dir, o) => {
    const { embed: _e, ...w } = await base(dir, o);
    return {
      ...w,
      mode: 'local',
      embedder: {
        active: 'voyage/voyage-3.5-lite',
        bound: 'local/bge-small-en-v1.5',
        matches: false,
      },
      reembedWith: fakeEmbedder,
    };
  };
}

/** A decider whose gate fails like a network error: import stops those sessions. */
function failingDecide(h: Harness): void {
  const decide: DecisionController = {
    ...fakeDecide,
    async gate() {
      throw new Error('upstream unavailable');
    },
  };
  const base = h.wire;
  h.wire = async (dir, o) => ({ ...(await base(dir, o)), decide });
}

const transcripts = (h: Harness): string => {
  const projects = path.join(h.root, 'projects');
  writeTranscript(projects, h.cwd);
  return projects;
};

async function emptySqlite(h: Harness): Promise<void> {
  fs.mkdirSync(h.home, { recursive: true });
  const s = await openSqliteStore({
    path: path.join(h.home, 'oort.sqlite'),
    coldDir: path.join(h.home, 'cold'),
    dimension: 512,
    log: () => {},
  });
  await s.close();
}

describe('exit codes match docs/cli.md (CON-107)', () => {
  // One row per changed path: what runs, and the code docs/cli.md promises.
  const table: [string, (h: Harness) => Promise<{ code: number }>, number][] = [
    // Not running exits 1, so `oort serve status || oort serve --detach` works.
    ['serve status, not running', (h) => h.run(['serve', 'status']), 1],
    ['serve status --json, not running', (h) => h.run(['serve', 'status', '--json']), 1],
    [
      'forget, declined',
      async (h) => {
        const m = memory();
        await h.store.upsert(TG, m);
        return h.run(['forget', m.id], terminal);
      },
      0,
    ],
    [
      'reembed, declined',
      async (h) => {
        needsPaidReembed(h);
        return h.run(['reembed'], terminal);
      },
      0,
    ],
    [
      'import, declined',
      (h) => h.run(['import', 'claude-code', '--projects-dir', transcripts(h)], terminal),
      0,
    ],
    [
      'import with failed sessions (partial success)',
      async (h) => {
        failingDecide(h);
        return h.run([
          'import',
          'claude-code',
          '--projects-dir',
          transcripts(h),
          '--include-unresolved',
          '--yes',
        ]);
      },
      3,
    ],
    [
      'import, every session imported',
      (h) =>
        h.run([
          'import',
          'claude-code',
          '--projects-dir',
          transcripts(h),
          '--include-unresolved',
          '--yes',
        ]),
      0,
    ],
    [
      'a confirmation without a terminal on stdin',
      async (h) => {
        const m = memory();
        await h.store.upsert(TG, m);
        return h.run(['forget', m.id]);
      },
      2,
    ],
    [
      'a confirmation with --json',
      async (h) => {
        const pack = path.join(h.root, 'p.pack.jsonl');
        await h.run([
          'judge',
          'record',
          '--subject',
          's',
          '--verdict',
          'approved',
          '--reason',
          'r',
        ]);
        await h.run(['judge', 'pack', 'export', '--out', pack]);
        const r = await h.run(['judge', 'pack', 'import', pack, '--json'], {
          ...terminal,
          answer: 'y',
        });
        expect(r.io.stderr).toMatch(JSON_NEVER_ASKS);
        return r;
      },
      2,
    ],
    [
      'a confirmation answered yes with stdout piped',
      async (h) => {
        const m = memory();
        await h.store.upsert(TG, m);
        return h.run(['forget', m.id], PIPED_YES);
      },
      0,
    ],
    [
      'observe --json (a no-op flag)',
      (h) => h.run(['observe', '--json', '--user', 'a', '--assistant', 'b']),
      0,
    ],
    ['import of an unknown harness', (h) => h.run(['import', 'cursor']), 2],
  ];

  it.each(table)('exit.%s', async (_label, run, code) => {
    const h = harness();
    const r = (await run(h)) as { code: number; io?: { stderr: string } };
    expect(r.code, r.io?.stderr).toBe(code);
  });

  it('exit.serve-status-not-running-exits-1-and-the-json-still-says-so', async () => {
    const h = harness();
    const text = await h.run(['serve', 'status']);
    expect(text.code).toBe(1);
    expect(text.io.stdout).toMatch(/state +not running/);
    const json = await h.run(['serve', 'status', '--json']);
    expect(json.code).toBe(1);
    expect(data(json.io.stdout)).toMatchObject({ running: false });
  });

  it('exit.import-with-failed-sessions-exits-3-and-says-to-re-run', async () => {
    const h = harness();
    failingDecide(h);
    const r = await h.run([
      'import',
      'claude-code',
      '--projects-dir',
      transcripts(h),
      '--include-unresolved',
      '--yes',
    ]);
    expect(r.code).toBe(3);
    expect(r.io.stdout).toMatch(/session\(s\) stopped at a failed observation; re-run/);
  });
});

describe('local commands that ask first (CON-107)', () => {
  // Each refuses without a terminal on stdin, exits 0 when declined, and asks on stderr even
  // with stdout piped (`| tee log`), acting on yes. The question is never on stdout.
  it('confirm.forget-no-tty-declined-piped-yes', async () => {
    const h = harness();
    const m = memory();
    await h.store.upsert(TG, m);
    expectRefusedWithoutPrompt(await h.run(['forget', m.id]), NO_TTY_STDIN);
    const no = await h.run(['forget', m.id], terminal);
    expectDeclined(no);
    expect(no.io.stdout).toBe('Kept.\n');
    expect(await h.store.get(TG, m.id)).not.toBeNull();
    const yes = await h.run(['forget', m.id], PIPED_YES);
    expectAsked(yes);
    expect(yes.io.stdout).toBe(`Forgot ${m.id}.\n`);
    expect(await h.store.get(TG, m.id)).toBeNull();
  });

  it('confirm.reembed-no-tty-declined-exits-0-piped-yes-runs', async () => {
    const h = harness();
    needsPaidReembed(h);
    expectRefusedWithoutPrompt(await h.run(['reembed']), NO_TTY_STDIN);
    const no = await h.run(['reembed'], terminal);
    expectDeclined(no);
    expect(no.io.asked[0]).toContain('billed by the provider');
    expect(no.io.stdout).toContain('Nothing re-embedded.');
    await emptySqlite(h);
    const yes = await h.run(['reembed'], PIPED_YES);
    expectAsked(yes);
    expect(yes.io.stdout).toContain('re-embedded 0 memories');
  });

  it('confirm.import-no-tty-declined-piped-yes', async () => {
    const h = harness();
    const projects = transcripts(h);
    const args = ['import', 'claude-code', '--projects-dir', projects, '--include-unresolved'];
    expectRefusedWithoutPrompt(await h.run(args), NO_TTY_STDIN);
    const no = await h.run(args, terminal);
    expectDeclined(no);
    expect(no.io.stdout).toContain('Nothing imported.');
    const yes = await h.run(args, PIPED_YES);
    expectAsked(yes);
    expect(yes.io.stdout).toMatch(/added [1-9]/);
  });

  it('confirm.forget-shows-escape-sequences-in-memory-text-never-runs-them', async () => {
    const h = harness();
    // ESC [2J clears the screen; C1 CSI does the same in one byte. Built from escapes.
    const m = memory({ text: 'deploy \u001b[2Jfrom main\u009b31m today' });
    await h.store.upsert(TG, m);
    const r = await h.run(['forget', m.id], terminal);
    expectDeclined(r);
    const q = r.io.asked[0]!;
    expect(q).not.toContain('\u001b');
    expect(q).not.toContain('\u009b');
    expect(q).toContain('\\u{1b}[2Jfrom main\\u{9b}31m');
  });
});

describe('one remedy for a missing key (CON-107)', () => {
  const REMEDY =
    '`oort models pull` (free local embed and rerank, no keys), `oort keys set voyage`, or `oort login` (Oort Pro)';

  it('remedy.reads-as-a-sentence-with-and-without-a-key-store', () => {
    // Without a key store and no local model for the role, the remedy is an instruction to set
    // variables, so it must not read "Run set …".
    for (const role of ['decide', 'write'] as const) {
      const s = remedySentence({ roles: [role], keyStore: false });
      expect(s).toMatch(/^Set [A-Z_]+_API_KEY in the environment your agent starts with/);
      expect(s).not.toMatch(/Run set/);
    }
    expect(remedySentence({ roles: ['embed'], keyStore: false })).toMatch(
      /^Run `oort models pull`/,
    );
    expect(remedySentence({ roles: ['decide'] })).toMatch(/^Run `oort keys set typesafe`/);
    const err = new MissingCredentialError('TYPESAFE_API_KEY', 'typesafe');
    expect(adapterProblem(err, 'decide', false)).not.toMatch(/Run set/);
  });

  it('remedy.recall-lexical-only-hint', async () => {
    const h = harness({ adapters: false });
    await h.store.upsert(TG, memory());
    const r = await h.run(['recall', 'auth service port']);
    expect(r.code).toBe(0);
    expect(r.io.stderr).toBe(`oort: lexical-only recall. No embed model or key. Run ${REMEDY}.\n`);
    expect(r.io.stderr).not.toContain('export VOYAGE_API_KEY');
  });

  it('remedy.reembed-refusal', async () => {
    const h = harness({ adapters: false });
    const r = await h.run(['reembed']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('oort models pull');
    expect(r.io.stderr).toContain(REMEDY);
    expect(r.io.stderr).not.toContain('export VOYAGE_API_KEY');
    expect(r.io.stderr).not.toContain('oort: oort');
  });

  // No Keychain or credentials.json (OORT_NO_KEYCHAIN=1, CI, containers): `oort keys set` and
  // `oort login` would refuse, so the remedy names the variables instead.
  const NO_STORE_REMEDY =
    '`oort models pull` (free local embed and rerank, no keys), set VOYAGE_API_KEY in the environment your agent starts with, or set OORT_API_KEY from oortcloud.dev/account (Oort Pro)';

  it('remedy.no-key-store-recall-hint-names-the-variable', async () => {
    const h = harness({ adapters: false, keyStore: false });
    await h.store.upsert(TG, memory());
    const r = await h.run(['recall', 'auth service port']);
    expect(r.code).toBe(0);
    expect(r.io.stderr).toBe(
      `oort: lexical-only recall. No embed model or key. Run ${NO_STORE_REMEDY}.\n`,
    );
    expect(r.io.stderr).not.toContain('oort keys set');
    expect(r.io.stderr).not.toContain('oort login');
  });

  it('remedy.no-key-store-reembed-names-the-variable', async () => {
    const h = harness({ adapters: false, keyStore: false });
    const r = await h.run(['reembed']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain(NO_STORE_REMEDY);
    expect(r.io.stderr).not.toContain('oort keys set');
  });

  it('remedy.init-with-and-without-a-key-store', async () => {
    for (const kc of [memoryKeychain().kc, createKeychain({ platform: 'none' })]) {
      const h = harness();
      const r = await h.run(['init'], {}, kc);
      expect(r.code).toBe(0);
      expect(r.io.stdout).toContain('oort models pull');
      expect(r.io.stdout).not.toContain('export VOYAGE_API_KEY');
      expect(r.io.stdout).not.toMatch(/export [A-Z_]+_API_KEY=/);
      // Saving needs decide and write keys, or Pro, even with local models.
      expect(r.io.stdout).toContain('decide and write need');
      expect(r.io.stdout).toContain(
        kc.supported
          ? 'Run `oort models pull` (free local embed and rerank, no keys), `oort keys set voyage`, `oort keys set typesafe` and `oort keys set anthropic`, or `oort login` (Oort Pro).'
          : 'set VOYAGE_API_KEY, TYPESAFE_API_KEY and ANTHROPIC_API_KEY in the environment your agent starts with',
      );
    }
  });

  it('remedy.init-with-local-models-asks-only-for-the-saving-keys', async () => {
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(
      path.join(h.home, 'config.json'),
      JSON.stringify({
        embed: { provider: 'local', model: 'bge-small-en-v1.5', dimension: 384 },
        rerank: { provider: 'local', model: 'ms-marco-minilm-l6' },
      }),
    );
    const r = await h.run(['init'], {}, memoryKeychain().kc);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).not.toContain('VOYAGE_API_KEY');
    expect(r.io.stdout).toContain('TYPESAFE_API_KEY');
    expect(r.io.stdout).toContain('ANTHROPIC_API_KEY');
    // Local models cover embed and rerank already: the list does not offer them as the fix.
    expect(r.io.stdout).toContain(
      'Run `oort keys set typesafe` and `oort keys set anthropic`, or `oort login` (Oort Pro); no local model does decide and write (`oort models pull` covers embed and rerank only), so saving needs one of these.',
    );
  });
});

describe('safeJson wherever memory text reaches --json (CON-107)', () => {
  it('escape.inspect-list-and-one', async () => {
    const h = harness();
    const m = memory({ text: HOSTILE });
    await h.store.upsert(TG, m);
    const list = await h.run(['inspect', '--json']);
    expect(list.code).toBe(0);
    expectEscaped(list.io.stdout);
    const one = await h.run(['inspect', m.id, '--json']);
    expect(one.code).toBe(0);
    expectEscaped(one.io.stdout);
  });

  it('escape.revalidate', async () => {
    const h = harness();
    const volatile = { stage: 'gate', question: 'volatile', answer: 'yes', probability: 0.8 };
    await h.store.upsert(
      TG,
      memory({ text: HOSTILE, source: { harness: 'claude-code', decisions: [volatile] } }),
    );
    const r = await h.run(['revalidate', '--json']);
    expect(r.code).toBe(0);
    expectEscaped(r.io.stdout);
  });

  it('escape.stats', async () => {
    const h = harness();
    const base = h.wire;
    // A project id is a string from the repository; stats prints it in its JSON.
    h.wire = async (dir, o) => {
      const w = await base(dir, o);
      return { ...w, scope: { ...localScope(HOSTILE), agentId: w.scope.agentId } };
    };
    const r = await h.run(['stats', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expectEscaped(r.io.stdout);
  });

  it('escape.observe', async () => {
    const h = harness();
    // A model's answers are untrusted strings, and observe prints its decisions.
    const decide: DecisionController = {
      ...fakeDecide,
      async gate() {
        return {
          shouldStore: 0.9,
          salience: 0.5,
          types: { semantic: 1 },
          decisions: [{ stage: 'gate', question: 'store?', answer: HOSTILE, probability: 0.9 }],
        };
      },
    };
    const base = h.wire;
    h.wire = async (dir, o) => ({ ...(await base(dir, o)), decide });
    const r = await h.run(['observe', '--user', 'remember this', '--assistant', 'noted']);
    expect(r.code, r.io.stderr).toBe(0);
    expectEscaped(r.io.stdout);
  });
});

describe('human output (CON-107)', () => {
  it('human.observe-json-wraps-the-same-result-in-the-envelope', async () => {
    const h = harness();
    const args = ['observe', '--user', 'which port?', '--assistant', 'port 5582'];
    const plain = await h.run(args);
    const json = await h.run([...args, '--json']);
    expect(json.code, json.io.stderr).toBe(0);
    // Without --json observe prints the bare result, as it always has; with it, the envelope.
    expect(Object.keys(data(json.io.stdout, 'observe'))).toEqual(
      Object.keys(JSON.parse(plain.io.stdout)),
    );
  });

  it('human.inspect-and-explain-say-so-when-empty', async () => {
    const h = harness();
    const inspect = await h.run(['inspect']);
    expect(inspect.code).toBe(0);
    expect(inspect.io.stdout).toContain('• No memories here yet.');
    expect(inspect.io.stdout).not.toMatch(/^id +type +tier/m);
    const explain = await h.run(['explain', 'nothing matches this']);
    expect(explain.code).toBe(0);
    expect(explain.io.stdout).toContain('• No memories matched this query.');
    expect(explain.io.stdout).not.toMatch(/^rank +id/m);
  });

  it('human.inspect-shows-local-times-not-raw-iso', async () => {
    const h = harness();
    const m = memory();
    await h.store.upsert(TG, m);
    const r = await h.run(['inspect', m.id]);
    expect(r.io.stdout).toMatch(/^created +\d{4}-\d\d-\d\d \d\d:\d\d \(\d+\w+ ago\)$/m);
    expect(r.io.stdout).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
  });

  it('human.stats-shows-the-store-path-with-a-tilde', async () => {
    const h = harness();
    const r = await h.run(['stats']);
    expect(r.code).toBe(0);
    // The harness HOME is its root, and OORT_HOME is inside it.
    expect(r.io.stdout).toContain('(~/oort-home/oort.sqlite, including -wal)');
    expect(r.io.stdout).not.toContain(h.root);
  });

  it('human.models-has-no-double-blank-line', async () => {
    const h = harness();
    const r = await h.run(['models']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).not.toContain('\n\n\n');
    expect(r.io.stdout).toContain('\n\nRun `oort models pull`');
  });

  it('human.refusals-are-capitalised-without-oort-oort-or-phase-jargon', async () => {
    const h = harness();
    const unknown = await h.run(['import', 'cursor']);
    expect(unknown.io.stderr).toBe(
      'oort: Unknown source "cursor": import reads claude-code transcripts or an Oort export file, and no file is at that path.\n',
    );
    const privacy = await h.run(['project', 'privacy', 'maybe']);
    expect(privacy.io.stderr).toBe('oort: Project privacy takes public or private.\n');
    const observe = await h.run(['observe'], { stdin: '{nope' });
    expect(observe.io.stderr).toBe('oort: The input on stdin is not valid JSON.\n');
    const keyless = harness({ adapters: false });
    const save = await keyless.run(['observe', '--user', 'a', '--assistant', 'b']);
    expect(save.io.stderr).toMatch(/^oort: Saving needs the embed, decide, write adapter\(s\)/);
    for (const r of [unknown, privacy, observe, save]) {
      expect(r.io.stderr).not.toContain('oort: oort');
      expect(r.io.stderr).not.toContain('Phase 1');
    }
  });
});
