import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MemoryStore } from './adapters.js';
import type { Feedback } from './feedback.js';
import { localGrant } from './grant.js';
import type { Judgment } from './judgment.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory, Scope } from './model.js';
import type { Prediction, PredictionResolution } from './prediction.js';
import { makeMemory, TG } from './store-conformance.js';
import {
  buildTrainingExport,
  isTrainingExportFile,
  runTrainingExport,
  splitByGroup,
  splitByTime,
  trainingFilters,
  TrainingExportError,
  writeTrainingExport,
  type TrainingExportOptions,
} from './training-export.js';

/**
 * The training export: golden JSON Lines from a fixture store, every exclusion counted, origin
 * filters, scrubbing, the time split, the grant, and how files are written.
 */

const NOW = new Date('2026-11-16T12:00:00.000Z');
const SCOPE: Scope = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };
const GOLDEN = path.resolve(import.meta.dirname, '../test/fixtures/training');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-training-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// Secret-shaped values are built at run time, so the repository never holds one.
const AWS_KEY = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');
const GH_TOKEN = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');

const at = (day: number, hour = 9): string => new Date(Date.UTC(2026, 9, day, hour)).toISOString();

function judgmentMemory(id: string, j: Partial<Judgment>, m: Partial<Memory> = {}): Memory {
  const judgment: Judgment = {
    subject: { summary: `Item ${id}` },
    verdict: 'rejected',
    verdicts: ['approved', 'rejected'],
    reason: `Reason ${id}.`,
    criteria: [],
    domain: 'content',
    by: 'ada',
    decidedAt: at(1),
    via: 'cli',
    origin: 'interactive',
    ...j,
  };
  return makeMemory({
    id,
    scope: SCOPE,
    type: 'judgment',
    text: `Judgment ${id}`,
    pinned: true,
    tier: 'hot',
    validFrom: judgment.decidedAt,
    createdAt: judgment.decidedAt,
    updatedAt: judgment.decidedAt,
    judgment,
    ...m,
  });
}

/** Judgments: four a person made (one with a secret), and one of each kind that stays out. */
const JUDGMENTS: Memory[] = [
  judgmentMemory('j-interactive', {
    subject: { summary: 'Post says a vitamin cures the flu' },
    reason: 'A health claim with no cited source.\nIt also names a brand.',
    criteria: ['no-source'],
    decidedAt: at(1),
  }),
  judgmentMemory('j-dashboard', {
    subject: { summary: 'Satire piece about the moon landing', ref: 'https://example.com/p/2' },
    verdict: 'approved',
    reason: 'Satire, clearly labelled as parody.',
    origin: 'dashboard',
    reviewer: 'grace@example.com',
    decidedAt: at(2),
  }),
  judgmentMemory('j-connector', {
    subject: { summary: 'Ad for a payday loan' },
    reason: 'Financial product without the required disclosure.',
    origin: 'connector',
    upstream: { system: 'review-queue', actor: 'linus' },
    decidedAt: at(3),
  }),
  judgmentMemory('j-confirmed', {
    subject: { summary: 'Post links an unlicensed stream' },
    reason: 'Copyright: links pirated content.',
    via: 'mcp',
    origin: 'interactive',
    proposedOrigin: 'agent',
    confirmed: { at: at(4, 10), by: 'ada' },
    decidedAt: at(4),
  }),
  judgmentMemory('j-secret', {
    // Planted as an edited store would hold it: the write path would have scrubbed it.
    subject: { summary: 'Snippet \u202eshows a deploy key' },
    reason: `It pastes a live key: ${AWS_KEY}.`,
    decidedAt: at(5),
  }),
  judgmentMemory('j-integration', { origin: 'integration', via: 'sdk', decidedAt: at(6) }),
  judgmentMemory('j-agent', { via: 'mcp', origin: 'agent', decidedAt: at(6) }),
  judgmentMemory('j-withdrawn', { withdrawn: { at: at(7), by: 'ada' }, decidedAt: at(6) }),
  judgmentMemory('j-purged', {
    reason: '[purged]',
    withdrawn: { at: at(7), by: 'ada' },
    purged: { at: at(7), by: 'ada' },
  }),
  judgmentMemory(
    'j-corrected',
    { decidedAt: at(2) },
    { endReason: 'corrected', expiredAt: at(3), validTo: at(3) },
  ),
  judgmentMemory('j-pack', {
    via: 'pack',
    origin: undefined,
    pack: {
      id: 'abcdef0123456789',
      name: 'shared',
      exportedAt: at(1),
      exportedBy: 'cursor',
      originalId: 'x',
      importedAt: at(2),
    },
  }),
];

function prediction(
  id: string,
  over: Partial<Prediction>,
  resolution?: Partial<PredictionResolution>,
): Prediction {
  return {
    id,
    scope: SCOPE,
    item: { summary: `Item ${id}` },
    domain: 'content',
    outcome: 'suggested',
    verdict: 'approved',
    probability: 0.8,
    verdicts: ['approved', 'rejected'],
    precedentIds: [],
    criteria: [],
    similarity: 'lexical',
    threshold: 0.7,
    revision: 1,
    createdAt: at(1),
    updatedAt: at(1),
    expiresAt: '2026-12-31T00:00:00.000Z',
    ...over,
    ...(resolution !== undefined && {
      resolution: {
        verdict: 'rejected',
        criteria: [],
        by: 'ada',
        at: at(2),
        via: 'cli',
        origin: 'interactive',
        agrees: false,
        ...resolution,
      },
    }),
  };
}

const PREDICTIONS: Prediction[] = [
  prediction(
    'p-disagreed',
    {
      item: {
        summary: 'Post says garlic cures infections',
        details: 'A reel with 40k views.',
        ref: 'https://example.com/r/9',
      },
    },
    { reason: 'Health claim with no source.', at: at(8) },
  ),
  prediction(
    'p-no-reason',
    { item: { summary: 'Review praising a product the author sells' } },
    { origin: 'dashboard', reviewer: 'grace@example.com', at: at(9) },
  ),
  prediction(
    'p-confirmed',
    { item: { summary: 'Thread doxxing a streamer' } },
    {
      reason: 'Personal data of a private person.',
      via: 'mcp',
      origin: 'interactive',
      proposedOrigin: 'agent',
      confirmed: { at: at(10, 11), by: 'ada' },
      at: at(10),
    },
  ),
  prediction('p-agreed', {}, { verdict: 'approved', agrees: true }),
  prediction('p-pending', {}),
  prediction('p-expired', { expiresAt: at(5) }),
  prediction('p-agent', {}, { via: 'mcp', origin: 'agent' }),
  prediction('p-purged', { purged: { at: at(3), by: 'ada' } }, {}),
  prediction('p-integration', {}, { origin: 'integration', via: 'sdk' }),
  prediction('p-none', { verdict: null, probability: null }, { agrees: null }),
];

const MEMORIES: Memory[] = [
  ['m-port', 'The auth service listens on port 5502 in staging.'],
  ['m-lunch', 'The team orders lunch on Fridays.'],
  ['m-deploy', 'Deploys run from the release branch on Thursdays.'],
  ['m-db', 'The staging database runs Postgres 16.'],
  ['m-gone', 'A memory the export cannot read any more.'],
].map(([id, text]) =>
  makeMemory({ id: id!, scope: SCOPE, text: text!, createdAt: at(1), validFrom: at(1) }),
);

function feedback(id: string, over: Partial<Feedback>): Feedback {
  return {
    id,
    scope: SCOPE,
    memoryId: 'm-port',
    signal: 'irrelevant',
    by: 'ada',
    via: 'cli',
    origin: 'interactive',
    status: 'recorded',
    revision: 0,
    createdAt: at(11),
    updatedAt: at(11),
    ...over,
  };
}

const FEEDBACK: Feedback[] = [
  feedback('f-neg-lunch', { memoryId: 'm-lunch', query: 'auth service port', createdAt: at(11) }),
  feedback('f-pos-port', {
    signal: 'helped',
    memoryId: 'm-port',
    query: 'auth service port',
    origin: 'dashboard',
    reviewer: 'grace@example.com',
    createdAt: at(12),
  }),
  feedback('f-neg-deploy', {
    memoryId: 'm-deploy',
    query: 'auth service port',
    createdAt: at(13),
  }),
  feedback('f-neg-alone', {
    memoryId: 'm-lunch',
    // Planted: the write path would have scrubbed both.
    query: `deploy token ${GH_TOKEN}`,
    note: `The token is ${GH_TOKEN}`,
    createdAt: at(14),
  }),
  feedback('f-pos-alone', {
    signal: 'helped',
    memoryId: 'm-db',
    query: 'which postgres in staging',
    via: 'mcp',
    proposedOrigin: 'agent',
    confirmed: { at: at(15, 10), by: 'ada' },
    createdAt: at(15),
  }),
  feedback('f-helped-no-query', { signal: 'helped', memoryId: 'm-db' }),
  feedback('f-pending', { via: 'mcp', origin: 'agent', status: 'pending', query: 'q' }),
  feedback('f-dismissed', { signal: 'wrong', status: 'dismissed', note: 'n' }),
  feedback('f-wrong', { signal: 'wrong', status: 'open', note: 'It moved.' }),
  feedback('f-gone', { memoryId: 'm-gone', query: 'q' }),
  feedback('f-integration', { via: 'sdk', origin: 'integration', query: 'q' }),
];

/** The fixture store; `m-gone` reads as forgotten (a row left by an older Oort). */
async function fixture(): Promise<MemoryStore> {
  const store = createMemoryStore({ now: () => NOW });
  await store.upsertMany(TG, [...JUDGMENTS, ...MEMORIES]);
  for (const p of PREDICTIONS) await store.putPrediction!(TG, p);
  for (const f of FEEDBACK) expect(await store.putFeedback!(TG, f)).toBe('written');
  const get = store.get.bind(store);
  return Object.assign(Object.create(store) as MemoryStore, {
    get: (g: typeof TG, id: string) => (id === 'm-gone' ? Promise.resolve(null) : get(g, id)),
  });
}

const build = async (opts: Partial<TrainingExportOptions> = {}, store?: MemoryStore) =>
  buildTrainingExport(
    { kind: 'all', ...opts },
    { store: store ?? (await fixture()), grant: TG, version: '0.0.0-test', now: NOW },
  );

const rowsOf = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const contentsOf = (exp: Awaited<ReturnType<typeof build>>, name: string): string =>
  exp.contents.find((c) => c.name === name)!.text;

describe('training export: golden files', () => {
  it('writes the fixture store as the checked-in JSON Lines, one file per kind', async () => {
    const exp = await build();
    expect(exp.contents.map((c) => c.name)).toEqual([
      'sft.jsonl',
      'preference.jsonl',
      'retrieval.jsonl',
    ]);
    for (const { name, text } of exp.contents) {
      const file = path.join(GOLDEN, name);
      if (process.env['OORT_UPDATE_GOLDEN'] === '1') fs.writeFileSync(file, text);
      expect(text, `${name} differs from test/fixtures/training`).toBe(
        fs.readFileSync(file, 'utf8'),
      );
    }
  });

  it('sft: the item, then the verdict and reason verbatim, oldest first', async () => {
    const rows = rowsOf(contentsOf(await build(), 'sft.jsonl'));
    expect(rows.map((r) => r['id'])).toEqual([
      'j-interactive',
      'j-dashboard',
      'j-connector',
      'j-confirmed',
      'j-secret',
    ]);
    expect(rows[0]).toEqual({
      messages: [
        { role: 'user', content: 'Post says a vitamin cures the flu' },
        {
          role: 'assistant',
          content:
            'Verdict: rejected\nReason: A health claim with no cited source.\nIt also names a brand.',
        },
      ],
      id: 'j-interactive',
      at: at(1),
      domain: 'content',
      origin: 'interactive',
    });
    expect(rows[1]).toMatchObject({ origin: 'dashboard', reviewer: 'grace@example.com' });
    expect((rows[1]!['messages'] as { content: string }[])[0]!.content).toBe(
      'Satire piece about the moon landing\n\nRef: https://example.com/p/2',
    );
    expect(rows[3]).toMatchObject({ origin: 'interactive', proposedOrigin: 'agent' });
  });

  it('preference: only disagreements, the proposal rejected and the decision chosen', async () => {
    const exp = await build();
    const rows = rowsOf(contentsOf(exp, 'preference.jsonl'));
    expect(rows.map((r) => r['id'])).toEqual(['p-disagreed', 'p-no-reason', 'p-confirmed']);
    // Both sides are verdict-only by default, so length says nothing about which is chosen.
    expect(rows[0]).toEqual({
      prompt:
        'Post says garlic cures infections\n\nA reel with 40k views.\n\nRef: https://example.com/r/9',
      chosen: 'Verdict: rejected',
      rejected: 'Verdict: approved',
      id: 'p-disagreed',
      at: at(8),
      domain: 'content',
      origin: 'interactive',
    });
    expect(rows[1]).toMatchObject({ chosen: 'Verdict: rejected', reviewer: 'grace@example.com' });
    expect(rows[2]).toMatchObject({ proposedOrigin: 'agent' });
    expect(exp.manifest.notes).toEqual([]);
  });

  it('preference: preferenceReasons adds the reason to chosen, and the manifest says rejected has none', async () => {
    const exp = await build({ preferenceReasons: true });
    const rows = rowsOf(contentsOf(exp, 'preference.jsonl'));
    expect(rows[0]).toMatchObject({
      chosen: 'Verdict: rejected\nReason: Health claim with no source.',
      rejected: 'Verdict: approved',
    });
    expect(rows[1]).toMatchObject({ chosen: 'Verdict: rejected' });
    expect(exp.manifest.filters.preferenceReasons).toBe(true);
    expect(exp.manifest.notes).toHaveLength(1);
    expect(exp.manifest.notes[0]).toMatch(/rejected .*has no reason/);
    // Without preference rows there is nothing to note.
    expect((await build({ kind: 'sft', preferenceReasons: true })).manifest.notes).toEqual([]);
  });

  it('retrieval: negatives paired with a positive of the same query, null when there is none', async () => {
    const rows = rowsOf(contentsOf(await build(), 'retrieval.jsonl'));
    const port = 'The auth service listens on port 5502 in staging.';
    expect(rows.map((r) => [r['query'], r['positive'], r['negative']])).toEqual([
      ['auth service port', port, 'The team orders lunch on Fridays.'],
      ['auth service port', port, 'Deploys run from the release branch on Thursdays.'],
      ['deploy token [REDACTED:github-token]', null, 'The team orders lunch on Fridays.'],
      ['which postgres in staging', 'The staging database runs Postgres 16.', null],
    ]);
    expect(rows[0]).toMatchObject({
      id: 'f-neg-lunch',
      origin: 'interactive',
      positiveId: 'f-pos-port',
      positiveOrigin: 'dashboard',
      positiveReviewer: 'grace@example.com',
      at: at(12),
    });
    expect(rows[3]).toMatchObject({ origin: 'interactive', proposedOrigin: 'agent' });
  });
});

describe('training export: what stays out', () => {
  it('counts every exclusion under its reason', async () => {
    const { manifest } = await build();
    expect(manifest.excluded).toEqual({
      sft: {
        purged: 1,
        withdrawn: 1,
        corrected: 1,
        'agent-unconfirmed': 1,
        'imported-from-pack': 1,
        'origin-not-selected': 1,
      },
      preference: {
        purged: 1,
        'agent-unconfirmed': 1,
        pending: 1,
        expired: 1,
        'no-proposal': 1,
        agreed: 1,
        'origin-not-selected': 1,
      },
      retrieval: {
        pending: 1,
        dismissed: 1,
        'not-a-retrieval-signal': 1,
        'helped-without-query': 1,
        'memory-forgotten': 1,
        'origin-not-selected': 1,
      },
    });
    const all = manifest.files.reduce((n, f) => n + f.rows, 0);
    expect(all).toBe(12);
  });

  it('never writes an agent label nobody confirmed, an ended judgment or closed feedback', async () => {
    const exp = await build({ include: ['integration'] });
    const text = exp.contents.map((c) => c.text).join('');
    for (const id of [
      'j-agent',
      'j-withdrawn',
      'j-purged',
      'j-corrected',
      'j-pack',
      'p-agent',
      'p-pending',
      'p-expired',
      'p-purged',
      'f-pending',
      'f-dismissed',
      'f-gone',
    ]) {
      expect(text, id).not.toContain(`"${id}"`);
    }
    expect(text).not.toContain('"origin":"agent"');
    expect(text).not.toContain('A memory the export cannot read any more.');
  });
});

describe('training export: origins', () => {
  const origins = async (opts: Partial<TrainingExportOptions>) => {
    const exp = await build(opts);
    const rows = exp.contents.flatMap((c) => rowsOf(c.text));
    return [...new Set(rows.map((r) => r['origin']))].sort();
  };

  it('defaults to interactive, dashboard and connector', async () => {
    expect(await origins({})).toEqual(['connector', 'dashboard', 'interactive']);
    expect((await build()).manifest.filters.origins).toEqual([
      'interactive',
      'dashboard',
      'connector',
    ]);
  });

  it('adds integration with include, and removes interactive with exclude', async () => {
    expect(await origins({ include: ['integration'] })).toEqual([
      'connector',
      'dashboard',
      'integration',
      'interactive',
    ]);
    expect(await origins({ exclude: ['interactive'] })).toEqual(['connector', 'dashboard']);
    const { manifest } = await build({ exclude: ['interactive'] });
    expect(manifest.counts.sft).toEqual({ rows: 2, origins: { dashboard: 1, connector: 1 } });
  });

  it('refuses agent, whatever the flags', async () => {
    expect(() => trainingFilters({ kind: 'all', include: ['agent'] })).toThrow(
      /agent labels are never exported/,
    );
    expect(() => trainingFilters({ kind: 'all', include: ['robot'] })).toThrow(TrainingExportError);
    expect(trainingFilters({ kind: 'all', exclude: ['agent'] }).origins).not.toContain('agent');
  });

  it('filters by expert and by time', async () => {
    const { manifest } = await build({ kind: 'sft', expert: 'grace', since: at(3) });
    expect(manifest.counts.sft!.rows).toBe(0);
    expect(manifest.excluded.sft!['expert-not-selected']).toBe(6);
    const later = await build({ kind: 'sft', since: at(3) });
    expect(later.manifest.counts.sft!.rows).toBe(3);
    expect(later.manifest.excluded.sft!['before-since']).toBe(2);
  });
});

describe('training export: scrubbing', () => {
  it('a secret in a judgment reason or a feedback row does not survive', async () => {
    const exp = await build();
    const text = exp.contents.map((c) => c.text).join('');
    expect(text).not.toContain(AWS_KEY);
    expect(text).not.toContain(GH_TOKEN);
    expect(text).toContain('[REDACTED:aws-access-key]');
    expect(text).not.toMatch(/[\u202a-\u202e]/);
    expect(exp.manifest.scrubbed).toEqual({ sft: 1, preference: 0, retrieval: 1 });
  });
});

describe('training export: the time split', () => {
  const rows = (times: number[]) =>
    times.map((t, i) => ({ at: new Date(t * 1000).toISOString(), id: `r${i}` }));

  it('puts no eval row before the latest train row', async () => {
    const exp = await build({ split: 'time:0.6' });
    expect(exp.contents.map((c) => c.name)).toEqual([
      'sft.train.jsonl',
      'sft.eval.jsonl',
      'preference.train.jsonl',
      'preference.eval.jsonl',
      'retrieval.train.jsonl',
      'retrieval.eval.jsonl',
    ]);
    for (const kind of ['sft', 'preference', 'retrieval']) {
      const train = rowsOf(contentsOf(exp, `${kind}.train.jsonl`));
      const evalRows = rowsOf(contentsOf(exp, `${kind}.eval.jsonl`));
      expect(train.length + evalRows.length).toBe(exp.manifest.counts[kind as 'sft']!.rows);
      const latest = Math.max(...train.map((r) => Date.parse(r['at'] as string)));
      for (const r of evalRows) expect(Date.parse(r['at'] as string)).toBeGreaterThan(latest);
    }
    expect(exp.manifest.counts.sft).toMatchObject({ train: { rows: 3 }, eval: { rows: 2 } });
    expect(exp.manifest.filters.split).toEqual({ by: 'time', train: 0.6 });
  });

  it('never splits rows with the same time, and picks the same side every run', () => {
    // The cut at 0.3 falls inside the group at t=2: most of it is on the eval side.
    const r = rows([1, 2, 2, 2, 3, 4]);
    const s = splitByTime(r, 0.3);
    expect(s.train.map((x) => x.id)).toEqual(['r0']);
    expect(s.eval.map((x) => x.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    // Most of it on the train side: the whole group trains.
    expect(splitByTime(rows([1, 1, 1, 2, 3]), 0.4).train.map((x) => x.id)).toEqual([
      'r0',
      'r1',
      'r2',
    ]);
    // An even split of the group: train.
    expect(splitByTime(rows([1, 2, 2, 3]), 0.5).train.map((x) => x.id)).toEqual(['r0', 'r1', 'r2']);
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const many = rows([1, 1, 2, 2, 2, 3, 3, 4, 5, 5, 5, 5]);
      const { train, eval: ev } = splitByTime(many, f);
      const last = Math.max(...train.map((x) => Date.parse(x.at)));
      for (const x of ev) expect(Date.parse(x.at)).toBeGreaterThan(last);
    }
  });

  it('refuses a split that is not time:<fraction> between 0 and 1', () => {
    for (const split of ['0.8', 'time:1', 'time:0', 'time:1.5', 'random:0.8', 'time:abc']) {
      expect(() => trainingFilters({ kind: 'all', split }), split).toThrow(/split must be/);
    }
  });
});

describe('training export: the grant', () => {
  it('a grant for project B reads nothing bound to project A', async () => {
    const a: Scope = { ...SCOPE, projectId: 'proj-a' };
    const store = createMemoryStore({ now: () => NOW });
    await store.upsertMany(TG, [
      ...JUDGMENTS.slice(0, 2).map((m) => ({ ...m, scope: a })),
      ...MEMORIES.map((m) => ({ ...m, scope: a })),
    ]);
    await store.putPrediction!(TG, { ...PREDICTIONS[0]!, scope: a });
    for (const f of FEEDBACK.slice(0, 2)) await store.putFeedback!(TG, { ...f, scope: a });
    const onlyB = localGrant({ ...SCOPE, projectIds: ['proj-b'] });
    const exp = await buildTrainingExport(
      { kind: 'all' },
      { store, grant: onlyB, version: '0', now: NOW },
    );
    expect(exp.contents.map((c) => c.text)).toEqual(['', '', '']);
    expect(exp.manifest.excluded).toEqual({ sft: {}, preference: {}, retrieval: {} });
    // The same store read for project A has them.
    const onlyA = localGrant({ ...SCOPE, projectIds: ['proj-a'] });
    const mine = await buildTrainingExport(
      { kind: 'all' },
      { store, grant: onlyA, version: '0', now: NOW },
    );
    expect(mine.manifest.files.map((f) => f.rows)).toEqual([2, 1, 1]);
  });
});

describe('training export: the manifest', () => {
  it('records time, version, filters, counts, exclusions, scrub changes and each sha256', async () => {
    const { manifest, contents } = await build({ kind: 'preference', expert: 'ada' });
    expect(manifest).toMatchObject({
      oort: 'training-export',
      version: 1,
      exportedAt: NOW.toISOString(),
      oortVersion: '0.0.0-test',
      filters: {
        kind: 'preference',
        kinds: ['preference'],
        include: [],
        exclude: [],
        expert: 'ada',
        since: null,
        split: null,
        preferenceReasons: false,
      },
      counts: { preference: { rows: 3, origins: { interactive: 2, dashboard: 1 } } },
      scrubbed: { preference: 0 },
      notes: [],
    });
    const { createHash } = await import('node:crypto');
    expect(manifest.files).toEqual([
      {
        name: 'preference.jsonl',
        kind: 'preference',
        part: 'all',
        rows: 3,
        sha256: createHash('sha256').update(contents[0]!.text).digest('hex'),
      },
    ]);
  });

  it('a store without predictions or feedback exports none of them', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const bare = Object.assign(Object.create(store) as MemoryStore, {
      predictions: undefined,
      feedback: undefined,
    });
    const exp = await build({}, bare);
    expect(exp.manifest.files.map((f) => f.rows)).toEqual([0, 0, 0]);
  });
});

describe('training export: writing files', () => {
  const mode = (p: string): number => fs.statSync(p).mode & 0o777;
  const posix = process.platform !== 'win32';

  it('writes one file per kind and the manifest, files 0600 in a 0700 directory', async () => {
    const out = path.join(dir, 'fresh', 'export');
    const written = writeTrainingExport(out, await build());
    expect(written.map((p) => path.basename(p))).toEqual([
      'sft.jsonl',
      'preference.jsonl',
      'retrieval.jsonl',
      'manifest.json',
    ]);
    for (const p of written) expect(path.dirname(p)).toBe(out);
    if (posix) {
      expect(mode(out)).toBe(0o700);
      for (const p of written) expect(mode(p)).toBe(0o600);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.files[0].sha256).toBe(
      (await import('node:crypto'))
        .createHash('sha256')
        .update(fs.readFileSync(path.join(out, 'sft.jsonl')))
        .digest('hex'),
    );
  });

  it('refuses a directory holding an earlier export unless forced, and leaves other files', async () => {
    const out = path.join(dir, 'again');
    writeTrainingExport(out, await build({ split: 'time:0.5' }));
    fs.writeFileSync(path.join(out, 'notes.txt'), 'mine');
    const err = (() => {
      try {
        writeTrainingExport(out, { manifest: {} as never, contents: [] });
      } catch (e) {
        return e as TrainingExportError;
      }
      return undefined;
    })();
    expect(err?.kind).toBe('exists');
    // Forced: the earlier export's files go, so no split file of the last run is left behind.
    writeTrainingExport(out, await build(), { force: true });
    expect(fs.readdirSync(out).sort()).toEqual([
      'manifest.json',
      'notes.txt',
      'preference.jsonl',
      'retrieval.jsonl',
      'sft.jsonl',
    ]);
    if (posix) expect(mode(path.join(out, 'sft.jsonl'))).toBe(0o600);
  });

  it('leaves an existing directory mode alone, and refuses one other users can write to', async () => {
    const open = path.join(dir, 'open');
    fs.mkdirSync(open, { mode: 0o755 });
    fs.chmodSync(open, 0o755);
    writeTrainingExport(open, await build({ kind: 'sft' }));
    if (posix) {
      expect(mode(open)).toBe(0o755);
      expect(mode(path.join(open, 'sft.jsonl'))).toBe(0o600);
      const shared = path.join(dir, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      const err = (() => {
        try {
          writeTrainingExport(shared, { manifest: {} as never, contents: [] });
        } catch (e) {
          return e as TrainingExportError;
        }
        return undefined;
      })();
      expect(err?.kind).toBe('unsafe-directory');
      expect(err?.message).toMatch(/writable by other users/);
      expect(mode(shared)).toBe(0o777);
      expect(fs.readdirSync(shared)).toEqual([]);
    }
  });

  it('refuses a file or a symlink as the directory', async () => {
    const open = path.join(dir, 'link-target');
    fs.mkdirSync(open, { mode: 0o700 });
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, '');
    expect(() => writeTrainingExport(file, { manifest: {} as never, contents: [] })).toThrow(
      /is a file/,
    );
    const link = path.join(dir, 'a-link');
    fs.symlinkSync(open, link);
    expect(() => writeTrainingExport(link, { manifest: {} as never, contents: [] })).toThrow(
      /symlink/,
    );
  });

  it('never writes through a symlink planted as an export file', async () => {
    const out = path.join(dir, 'planted');
    fs.mkdirSync(out);
    const target = path.join(dir, 'outside.txt');
    fs.writeFileSync(target, 'untouched');
    fs.symlinkSync(target, path.join(out, 'sft.jsonl'));
    expect(() => writeTrainingExport(out, { manifest: {} as never, contents: [] })).toThrow(
      /already holds an export/,
    );
    writeTrainingExport(out, await build({ kind: 'sft' }), { force: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    expect(fs.lstatSync(path.join(out, 'sft.jsonl')).isSymbolicLink()).toBe(false);
  });

  it('knows its own file names', () => {
    for (const n of [
      'manifest.json',
      'sft.jsonl',
      'preference.train.jsonl',
      'retrieval.eval.jsonl',
    ]) {
      expect(isTrainingExportFile(n), n).toBe(true);
    }
    for (const n of ['notes.txt', 'sft.json', 'other.jsonl', 'sft.test.jsonl']) {
      expect(isTrainingExportFile(n), n).toBe(false);
    }
  });
});

describe('training export: a resolve whose judgment changed since', () => {
  it('a corrected or forgotten judgment takes its preference row out, with or without reasons', async () => {
    const store = await fixture();
    await store.upsertMany(TG, [
      judgmentMemory(
        'j-resolved',
        { decidedAt: at(16) },
        { endReason: 'corrected', expiredAt: at(17), validTo: at(17) },
      ),
    ]);
    await store.putPrediction!(
      TG,
      prediction('p-corrected', {}, { reason: 'Changed my mind.', judgmentId: 'j-resolved' }),
    );
    await store.putPrediction!(TG, prediction('p-forgotten', {}, { judgmentId: 'j-gone' }));
    for (const preferenceReasons of [false, true]) {
      const exp = await build({ kind: 'preference', preferenceReasons }, store);
      const ids = rowsOf(contentsOf(exp, 'preference.jsonl')).map((r) => r['id']);
      expect(ids).toEqual(['p-disagreed', 'p-no-reason', 'p-confirmed']);
      expect(exp.manifest.excluded.preference).toMatchObject({
        corrected: 1,
        'memory-forgotten': 1,
      });
      expect(contentsOf(exp, 'preference.jsonl')).not.toContain('Changed my mind');
    }
  });
});

describe('training export: fields cleaned on the way out', () => {
  it('cleans domain and the expert filter, and normalizes or leaves out label times', async () => {
    const store = await fixture();
    await store.upsertMany(TG, [
      judgmentMemory('j-offset', {
        decidedAt: '2026-10-20T11:00:00+02:00',
        domain: `content \u200b${AWS_KEY}`,
      }),
      // Date.parse reads it, but it is not ISO: a store edited by hand.
      judgmentMemory(
        'j-bad-time',
        { decidedAt: 'Tue Oct 20 2026' },
        { validFrom: at(1), createdAt: at(1), updatedAt: at(1) },
      ),
    ]);
    const exp = await build({ kind: 'sft' }, store);
    const row = rowsOf(contentsOf(exp, 'sft.jsonl')).find((r) => r['id'] === 'j-offset')!;
    expect(row['at']).toBe('2026-10-20T09:00:00.000Z');
    expect(row['domain']).not.toContain(AWS_KEY);
    expect(row['domain']).toContain('[REDACTED:aws-access-key]');
    expect(exp.manifest.excluded.sft!['invalid-time']).toBe(1);
    const filtered = await build({ kind: 'sft', expert: 'ada\u0007\u200b' });
    expect(filtered.manifest.filters.expert).toBe('ada');
  });
});

describe('training export: retrieval pairs and the split by query', () => {
  it('leaves out a memory marked both helped and irrelevant for one query, and counts it', async () => {
    const store = await fixture();
    await store.putFeedback!(
      TG,
      feedback('f-contra', {
        signal: 'helped',
        memoryId: 'm-lunch',
        query: 'auth service port',
        createdAt: at(16),
      }),
    );
    const exp = await build({ kind: 'retrieval' }, store);
    const rows = rowsOf(contentsOf(exp, 'retrieval.jsonl'));
    for (const r of rows) {
      if (r['query'] === 'auth service port') expect(r['negative']).not.toBe(r['positive']);
    }
    expect(rows.map((r) => r['id'])).not.toContain('f-neg-lunch');
    expect(exp.manifest.excluded.retrieval!['contradictory']).toBe(2);
  });

  it('keeps every row of one query on one side of the split, the same way every time', () => {
    const rows = [
      { at: at(1), q: 'a' },
      { at: at(2), q: 'b' },
      { at: at(3), q: 'b' },
      { at: at(4), q: 'c' },
      { at: at(5), q: 'a' },
    ];
    const s = splitByGroup(rows, 0.6, (r) => r.q);
    expect(s.train.map((r) => r.q)).toEqual(['b', 'b', 'c']);
    expect(s.eval.map((r) => r.q)).toEqual(['a', 'a']);
    expect(splitByGroup([...rows].reverse(), 0.6, (r) => r.q).train).toHaveLength(3);
  });

  it('splits the retrieval file by query', async () => {
    const store = await fixture();
    await store.putFeedback!(
      TG,
      feedback('f-port-late', { memoryId: 'm-db', query: 'auth service port', createdAt: at(20) }),
    );
    const exp = await build({ kind: 'retrieval', split: 'time:0.5' }, store);
    const queries = (name: string) =>
      new Set(rowsOf(contentsOf(exp, name)).map((r) => r['query'] as string));
    const train = queries('retrieval.train.jsonl');
    for (const q of queries('retrieval.eval.jsonl')) expect(train.has(q)).toBe(false);
  });
});

describe('training export: built and written while the store changes', () => {
  /** The fixture store, with `listFeedback` calls counted and `onList` run before each. */
  async function watched(onList: (call: number, base: MemoryStore) => Promise<void> | void) {
    const base = await fixture();
    let calls = 0;
    const list = base.listFeedback!.bind(base);
    const store = Object.assign(Object.create(base) as MemoryStore, {
      listFeedback: async (g: typeof TG, o?: Parameters<typeof list>[1]) => {
        calls++;
        await onList(calls, base);
        return list(g, o);
      },
    });
    return { store, calls: () => calls };
  }
  const run = (out: string, store: MemoryStore, force = false) =>
    runTrainingExport(
      out,
      { kind: 'all' },
      { store, grant: TG, version: '0.0.0-test', now: NOW },
      { force },
    );

  it('a memory forgotten after the build is not in the files written', async () => {
    const { store, calls } = await watched(async (call, base) => {
      // The second read is the check after the first build: the forget lands in between.
      if (call === 2) await base.forget(TG, 'm-lunch');
    });
    const out = path.join(dir, 'forgotten');
    const { written } = await run(out, store);
    expect(calls()).toBe(4);
    const all = written.map((p) => fs.readFileSync(p, 'utf8')).join('');
    expect(all).not.toContain('orders lunch');
    expect(fs.readdirSync(out).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a failure part-way leaves the earlier export as it was, and no temp file', async () => {
    const out = path.join(dir, 'kept');
    await run(out, await fixture());
    const before = Object.fromEntries(
      fs.readdirSync(out).map((n) => [n, fs.readFileSync(path.join(out, n), 'utf8')]),
    );
    const { store } = await watched((call) => {
      if (call === 2) throw new Error('disk gone');
    });
    await expect(run(out, store, true)).rejects.toThrow('disk gone');
    const after = Object.fromEntries(
      fs.readdirSync(out).map((n) => [n, fs.readFileSync(path.join(out, n), 'utf8')]),
    );
    expect(after).toEqual(before);
  });

  it('fails as store-changing when every check finds a change, and writes nothing', async () => {
    const { store } = await watched(async (call, base) => {
      if (call % 2 === 0) {
        await base.putFeedback!(TG, feedback(`f-new-${call}`, { query: 'q2', createdAt: at(1) }));
        await base.forget(TG, call === 2 ? 'm-lunch' : call === 4 ? 'm-deploy' : 'm-port');
      }
    });
    const out = path.join(dir, 'changing');
    const err = await run(out, store).catch((e: unknown) => e as TrainingExportError);
    expect(err).toBeInstanceOf(TrainingExportError);
    expect((err as TrainingExportError).kind).toBe('store-changing');
    expect(fs.existsSync(out)).toBe(false);
  });
});
