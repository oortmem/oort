import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Embedder, JudgeChoice, JudgeRequest, MemoryStore } from './adapters.js';
import { resolveConfig } from './config.js';
import { localGrant } from './grant.js';
import {
  JudgmentInputError,
  JudgmentPackError,
  evaluateJudgments,
  formatJudgmentPack,
  importJudgmentPack,
  isActiveJudgment,
  judge,
  judgmentText,
  parseCsv,
  parseJudgmentPack,
  packDigest,
  parseJudgmentRows,
  recordJudgment,
  withdrawJudgment,
  type JudgmentInput,
  type PackMeta,
} from './judgment.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory, Scope } from './model.js';
import { recall } from './recall.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const scopeOf = (agentId: string): Scope => ({ orgId: 'local', customerId: 'self', agentId });
const SCOPE = scopeOf('claude-code');
const grantOf = (agentId = 'claude-code') =>
  localGrant({ orgId: 'local', customerId: 'self', agentId, projectIds: [null] });

/**
 * A topic embedder: each text maps to the axis of the first topic word it holds, so items about
 * the same topic are near (cosine 1) and items about different topics are far (cosine 0).
 */
const TOPICS = [/\b(cure|cures|remedy|miracle|vitamin)\b/i, /\b(refactor|function|null|code)\b/i];
const topicEmbedder = (calls: string[][] = []): Embedder => ({
  dimension: 4,
  async embed(texts) {
    calls.push(texts);
    return texts.map((t) => {
      const i = TOPICS.findIndex((re) => re.test(t));
      const v = new Int8Array(4);
      v[i === -1 ? 3 : i] = 100;
      return v;
    });
  },
});

/** A decider double: answers `verdict` at `p`, and records what it was asked. */
function decider(verdict: string, p: number) {
  const asked: JudgeRequest[] = [];
  return {
    asked,
    decide: {
      async judge(req: JudgeRequest): Promise<JudgeChoice> {
        asked.push(req);
        const probabilities = Object.fromEntries(
          req.verdicts.map((v) => [v, v === verdict ? p : (1 - p) / (req.verdicts.length - 1)]),
        );
        return {
          verdict,
          probability: p,
          probabilities,
          decisions: [{ stage: 'judge', question: 'verdict', answer: verdict, probability: p }],
        };
      },
    },
  };
}

const ada = (over: Partial<JudgmentInput> = {}): JudgmentInput => ({
  subject: 'Post says a vitamin cures the flu',
  verdict: 'rejected',
  reason: 'Health claim with no cited source.',
  criteria: ['no-source', 'health-claim'],
  domain: 'content',
  by: 'ada',
  decidedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

async function seed(store: MemoryStore, inputs: JudgmentInput[], embed?: Embedder) {
  const out: Memory[] = [];
  for (const input of inputs) {
    const r = await recordJudgment(input, {
      store,
      grant: grantOf(),
      scope: SCOPE,
      ...(embed !== undefined && { embed }),
      now: NOW,
      via: 'cli',
    });
    out.push(r.memory);
  }
  return out;
}

describe('judgment memory: recording', () => {
  it('judgment.record-keeps-the-reason-verbatim', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const reason = 'Health claim with no cited source.\n  Second line, kept as written.';
    const r = await recordJudgment(
      ada({ reason, verdict: ' Rejected ', domain: 'Content', criteria: ['No Source'] }),
      {
        store,
        grant: grantOf(),
        scope: { ...SCOPE, projectId: 'oort-1a2b3c4d' },
        embed: topicEmbedder(),
        now: NOW,
        via: 'cli',
      },
    );
    expect(r.outcome).toBe('added');
    const m = (await store.get(grantOf(), r.memory.id))!;
    expect(m.type).toBe('judgment');
    expect(m.judgment).toEqual({
      subject: { summary: 'Post says a vitamin cures the flu' },
      verdict: 'rejected',
      verdicts: ['approved', 'rejected'],
      reason,
      criteria: ['no-source'],
      domain: 'content',
      by: 'ada',
      decidedAt: '2026-10-01T00:00:00.000Z',
      via: 'cli',
    });
    // Unbound to the project, pinned (never cold), embedded, and readable as text by recall.
    expect(m.scope.projectId).toBeUndefined();
    expect(m.pinned).toBe(true);
    expect(m.embedding?.length).toBe(4);
    expect(m.text).toBe(judgmentText(m.judgment!));
    expect(m.text).toContain(reason);
    expect(m.validFrom).toBe('2026-10-01T00:00:00.000Z');
    expect(isActiveJudgment(m, NOW)).toBe(true);
  });

  it('judgment.record-refuses-bad-input-naming-the-field', async () => {
    const store = createMemoryStore();
    const deps = { store, grant: grantOf(), scope: SCOPE, via: 'cli' as const };
    const bad: [Partial<JudgmentInput>, RegExp][] = [
      [{ verdict: 'maybe' }, /verdict must be one of: approved, rejected/],
      [{ reason: '   ' }, /reason is empty/],
      [{ subject: 'two\nlines' }, /subject holds control characters/],
      [{ domain: 'not a domain!' }, /domain must be a short label/],
      [{ verdicts: ['only'], verdict: 'only' }, /at least two/],
      [{ decidedAt: 'yesterday' }, /decidedAt/],
    ];
    for (const [over, re] of bad) {
      const e = await recordJudgment(ada(over), deps).catch((x: unknown) => x);
      expect(e, re.source).toBeInstanceOf(JudgmentInputError);
      expect((e as Error).message).toMatch(re);
    }
    expect(await store.list(grantOf(), { validOnly: false })).toEqual([]);
  });

  it('judgment.record-redacts-secrets', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const key = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
    const r = await recordJudgment(ada({ reason: `Leaked ${key} in the post.` }), {
      store,
      grant: grantOf(),
      scope: SCOPE,
      now: NOW,
      via: 'cli',
    });
    expect(r.redacted.length).toBeGreaterThan(0);
    expect(JSON.stringify(await store.list(grantOf()))).not.toContain(key);
  });

  it('judgment.same-item-corrects-and-same-decision-is-unchanged', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const deps = { store, grant: grantOf(), scope: SCOPE, now: NOW, via: 'cli' as const };
    const first = await recordJudgment(ada({ ref: 'post-1' }), deps);
    const again = await recordJudgment(ada({ ref: 'post-1' }), deps);
    expect(again.outcome).toBe('unchanged');
    expect(again.memory.id).toBe(first.memory.id);
    const fixed = await recordJudgment(
      ada({ ref: 'post-1', verdict: 'approved', reason: 'The source is in the caption.' }),
      deps,
    );
    expect(fixed.outcome).toBe('corrected');
    expect(fixed.supersedes).toBe(first.memory.id);
    const old = (await store.get(grantOf(), first.memory.id))!;
    expect(old.endReason).toBe('corrected');
    expect(old.supersededBy).toBe(fixed.memory.id);
    expect((await store.list(grantOf())).map((m) => m.id)).toEqual([fixed.memory.id]);
    // Another expert's judgment of the same item is their own.
    const other = await recordJudgment(ada({ ref: 'post-1', by: 'ben' }), deps);
    expect(other.outcome).toBe('added');
  });
});

describe('judgment memory: applying', () => {
  const cures = [
    ada(),
    ada({
      subject: 'Ad claims a miracle remedy cures back pain',
      reason: 'Medical claim, no study cited.',
    }),
    ada({ subject: 'Reel says vitamin C cures colds', reason: 'No source for a health claim.' }),
  ];

  it('judgment.agreeing-precedents-give-a-confident-prediction-with-reasons', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const embed = topicEmbedder();
    await seed(store, cures, embed);
    const d = decider('rejected', 0.91);
    const r = await judge(
      { summary: 'Story claims a herbal remedy cures anxiety', domain: 'content' },
      { store, grant: grantOf(), embed, decide: d.decide, now: NOW },
    );
    expect(r.status).toBe('suggested');
    expect(r.why).toBeUndefined();
    expect(r.prediction).toMatchObject({ verdict: 'rejected', probability: 0.91 });
    expect(r.similarity).toBe('dense');
    // Every prediction cites its precedents, each with the expert's reason.
    expect(r.precedents).toHaveLength(3);
    for (const p of r.precedents) {
      expect(p.near).toBe(true);
      expect(p.agrees).toBe(true);
      expect(p.reason.length).toBeGreaterThan(0);
      expect(p.by).toBe('ada');
    }
    expect(r.agreement).toEqual({ rejected: 1 });
    // The decider saw the precedents' reasons verbatim, and a choice over the verdict set.
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]!.verdicts.sort()).toEqual(['approved', 'rejected']);
    expect(d.asked[0]!.precedents.map((p) => p.reason).sort()).toEqual(
      cures.map((c) => c.reason).sort(),
    );
  });

  it('judgment.conflicting-precedents-need-the-expert', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const embed = topicEmbedder();
    await seed(
      store,
      [
        ada(),
        ada({
          subject: 'Post says vitamin D cures fatigue, citing a trial',
          verdict: 'approved',
          reason: 'Links a peer-reviewed trial.',
        }),
      ],
      embed,
    );
    const d = decider('rejected', 0.99);
    const r = await judge(
      { summary: 'Post says a vitamin cures headaches', domain: 'content' },
      { store, grant: grantOf(), embed, decide: d.decide, now: NOW },
    );
    expect(r.status).toBe('needs-expert');
    expect(r.why).toBe('precedents-disagree');
    expect(r.prediction).toBeUndefined();
    expect(r.agreement).toEqual({ rejected: 0.5, approved: 0.5 });
    // Both sides are shown, so the expert sees the conflict; the decider was never asked.
    expect(r.precedents.map((p) => p.verdict).sort()).toEqual(['approved', 'rejected']);
    expect(d.asked).toEqual([]);
  });

  it('judgment.far-precedents-need-the-expert', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const embed = topicEmbedder();
    await seed(store, cures, embed);
    const d = decider('rejected', 0.99);
    const r = await judge(
      { summary: 'Refactor the null check in the parser function', domain: 'content' },
      { store, grant: grantOf(), embed, decide: d.decide, now: NOW },
    );
    expect(r.status).toBe('needs-expert');
    expect(r.why).toBe('too-far');
    expect(r.prediction).toBeUndefined();
    // The nearest ones are still shown, marked as not near.
    expect(r.precedents.length).toBeGreaterThan(0);
    expect(r.precedents.every((p) => !p.near)).toBe(true);
    expect(d.asked).toEqual([]);
    // And with nothing recorded for the domain at all:
    const none = await judge(
      { summary: 'A contract clause', domain: 'legal' },
      { store, grant: grantOf(), embed, decide: d.decide, now: NOW },
    );
    expect(none).toMatchObject({ status: 'needs-expert', why: 'no-precedents', precedents: [] });
  });

  it('judgment.keyless-returns-precedents-only', async () => {
    const store = createMemoryStore({ now: () => NOW });
    await seed(store, cures); // no embedder either: lexical
    const r = await judge(
      { summary: 'Video claims a vitamin cures the flu overnight', domain: 'content' },
      { store, grant: grantOf(), now: NOW },
    );
    expect(r.status).toBe('precedents-only');
    expect(r.why).toBe('no-decider');
    expect(r.prediction).toBeUndefined();
    expect(r.similarity).toBe('lexical');
    expect(r.precedents.length).toBeGreaterThan(0);
    expect(r.precedents[0]!.subject.summary).toBe('Post says a vitamin cures the flu');
    expect(r.precedents[0]!.reason).toBe('Health claim with no cited source.');
  });

  it('judgment.low-confidence-needs-the-expert-but-shows-the-lean', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const embed = topicEmbedder();
    await seed(store, cures, embed);
    const r = await judge(
      { summary: 'Blog says a vitamin remedy cures stress', domain: 'content' },
      { store, grant: grantOf(), embed, decide: decider('rejected', 0.55).decide, now: NOW },
      { threshold: 0.8 },
    );
    expect(r.status).toBe('needs-expert');
    expect(r.why).toBe('low-confidence');
    expect(r.prediction?.verdict).toBe('rejected');
  });

  it('judgment.a-failed-decider-needs-the-expert', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const embed = topicEmbedder();
    await seed(store, cures, embed);
    const r = await judge(
      { summary: 'A vitamin cures everything', domain: 'content' },
      {
        store,
        grant: grantOf(),
        embed,
        decide: {
          judge: async () => {
            throw new Error('network');
          },
        },
        now: NOW,
      },
    );
    expect(r).toMatchObject({ status: 'needs-expert', why: 'decider-failed' });
    expect(r.degraded).toContain('decider-failed');
  });

  it('judgment.withdrawn-judgments-never-count', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const embed = topicEmbedder();
    const [a, b] = await seed(store, cures.slice(0, 2), embed);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-judgment-'));
    const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
    const recalled = async () =>
      (
        await recall(
          { text: 'miracle remedy cures back pain', scope: { ...SCOPE, projectIds: [null] } },
          { store, config, now: NOW },
        )
      ).memories.map((m) => m.id);
    // Recall shows a judgment as a precedent until it is withdrawn.
    expect(await recalled()).toContain(b!.id);
    expect(await withdrawJudgment(store, grantOf(), b!, 'ada', NOW)).toBe(true);
    expect(
      await withdrawJudgment(store, grantOf(), (await store.get(grantOf(), b!.id))!, 'ada', NOW),
    ).toBe(false);
    const d = decider('rejected', 0.9);
    const r = await judge(
      { summary: 'A vitamin cures colds', domain: 'content' },
      { store, grant: grantOf(), embed, decide: d.decide, now: NOW },
    );
    expect(r.precedents.map((p) => p.id)).toEqual([a!.id]);
    expect(d.asked[0]!.precedents).toHaveLength(1);
    // Not in packs, and not in recall either.
    const pack = parseJudgmentPack(
      formatJudgmentPack(await store.list(grantOf()), {
        name: 'p',
        exportedBy: 'claude-code',
        exportedAt: NOW,
      }),
    );
    expect(pack.lines.map((l) => l.id)).toEqual([a!.id]);
    expect(await recalled()).not.toContain(b!.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('judgment.domain-and-expert-filters', async () => {
    const store = createMemoryStore({ now: () => NOW });
    await seed(store, [ada(), ada({ by: 'ben', verdict: 'approved', reason: 'Fine by me.' })]);
    const r = await judge(
      { summary: 'Post says a vitamin cures the flu', domain: 'content', by: 'ben' },
      { store, grant: grantOf(), now: NOW },
    );
    expect(r.precedents.map((p) => p.by)).toEqual(['ben']);
    const other = await judge(
      { summary: 'Post says a vitamin cures the flu', domain: 'legal' },
      { store, grant: grantOf(), now: NOW },
    );
    expect(other.why).toBe('no-precedents');
  });
});

describe('judgment memory: packs', () => {
  it('judgment.pack-round-trip-keeps-attribution-and-origin', async () => {
    const from = createMemoryStore({ now: () => NOW });
    const embed = topicEmbedder();
    const made = await seed(
      from,
      [
        ada(),
        ada({
          subject: 'Code review: function swallows a null',
          domain: 'code-review',
          by: 'cy',
          reason: 'Errors must not be swallowed.',
        }),
      ],
      embed,
    );
    const text = formatJudgmentPack(await from.list(grantOf()), {
      name: 'ada-content',
      exportedBy: 'claude-code',
      exportedAt: NOW,
    });
    const pack = parseJudgmentPack(text);
    expect(pack.manifest).toMatchObject({
      oort: 'judgment-pack',
      version: 1,
      name: 'ada-content',
      exportedBy: 'claude-code',
      count: 2,
      domains: ['code-review', 'content'],
      experts: ['ada', 'cy'],
    });
    // No vectors travel.
    expect(text).not.toContain('embedding');

    // Into another agent's Star, on another store.
    const to = createMemoryStore({ now: () => NOW });
    const star = localGrant(
      { orgId: 'local', customerId: 'self', agentId: 'cursor', projectIds: [null] },
      { home: 'star' },
    );
    const later = new Date('2026-11-02T00:00:00.000Z');
    const r = await importJudgmentPack(pack, {
      store: to,
      grant: star,
      scope: scopeOf('cursor'),
      embed,
      now: later,
    });
    expect(r.added).toHaveLength(2);
    expect(r.skipped).toEqual([]);
    const got = await to.list(star);
    expect(got.every((m) => m.address?.level === 'agent')).toBe(true);
    const byOrig = new Map(got.map((m) => [m.judgment!.pack!.originalId, m]));
    for (const m of made) {
      const g = byOrig.get(m.id)!;
      const { via: _v, ...want } = m.judgment!;
      expect(g.judgment).toMatchObject(want);
      expect(g.judgment!.via).toBe('pack');
      expect(g.judgment!.pack).toEqual({
        id: pack.manifest.digest.slice(0, 16),
        name: 'ada-content',
        exportedAt: NOW.toISOString(),
        exportedBy: 'claude-code',
        originalId: m.id,
        importedAt: later.toISOString(),
      });
      expect(g.embedding?.length).toBe(4);
    }
    // Importing again adds nothing, and never brings back a judgment withdrawn here.
    const first = got[0]!;
    await withdrawJudgment(to, star, first, 'ada', later);
    const again = await importJudgmentPack(pack, {
      store: to,
      grant: star,
      scope: scopeOf('cursor'),
      now: later,
    });
    expect(again.added).toEqual([]);
    expect(again.skipped).toHaveLength(2);
    expect((await to.list(star)).map((m) => m.id)).not.toContain(first.id);
    // A re-exported pack keeps the first origin.
    const re = parseJudgmentPack(
      formatJudgmentPack(await to.list(star), {
        name: 'relay',
        exportedBy: 'cursor',
        exportedAt: later,
      }),
    );
    expect(re.lines[0]!.judgment.pack?.name).toBe('ada-content');
  });

  it('judgment.pack-refuses-a-changed-or-foreign-file', () => {
    const text = formatJudgmentPack([], { name: 'empty', exportedBy: 'x', exportedAt: NOW });
    expect(parseJudgmentPack(text).lines).toEqual([]);
    expect(() => parseJudgmentPack('{"oort":"export","version":2}\n')).toThrow(JudgmentPackError);
    const lines = text.trim().split('\n');
    const forged = JSON.stringify({ id: 'x', judgment: { ...ada(), subject: { summary: 'x' } } });
    expect(() => parseJudgmentPack([lines[0], forged].join('\n'))).toThrow(/manifest says 0/);
    const head = { ...JSON.parse(lines[0]!), count: 1 };
    expect(() => parseJudgmentPack([JSON.stringify(head), forged].join('\n'))).toThrow(/digest/);
  });
});

describe('judgment memory: bulk import and evaluation', () => {
  it('judgment.csv-and-jsonl-rows', () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,"two\nlines",3\n')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['1', 'two\nlines', '3'],
    ]);
    const csv = [
      'subject,verdict,reason,criteria,decided_at,ref',
      '"Post A, with a comma",rejected,"No source.",no-source;health-claim,2026-01-02,post-a',
      'Post B,approved,"Cites a study.",,,',
    ].join('\n');
    const rows = parseJudgmentRows(csv, 'csv', { domain: 'content', by: 'ada' });
    expect(rows).toEqual([
      {
        subject: 'Post A, with a comma',
        verdict: 'rejected',
        reason: 'No source.',
        domain: 'content',
        by: 'ada',
        ref: 'post-a',
        criteria: ['no-source', 'health-claim'],
        decidedAt: '2026-01-02',
      },
      {
        subject: 'Post B',
        verdict: 'approved',
        reason: 'Cites a study.',
        domain: 'content',
        by: 'ada',
      },
    ]);
    const jsonl = `${JSON.stringify({ subject: 'S', decision: 'rejected', reason: 'R', domain: 'legal', expert: 'eve', criteria: ['x'] })}\n`;
    expect(parseJudgmentRows(jsonl, 'jsonl')).toEqual([
      {
        subject: 'S',
        verdict: 'rejected',
        reason: 'R',
        domain: 'legal',
        by: 'eve',
        criteria: ['x'],
      },
    ]);
    expect(() => parseJudgmentRows('subject,verdict\nx,y', 'csv')).toThrow(/no reason column/);
    expect(() =>
      parseJudgmentRows(csv.replace('rejected', 'maybe'), 'csv', { domain: 'c', by: 'a' }),
    ).toThrow(/line 2: verdict/);
  });

  it('judgment.eval-reports-agreement-and-coverage-per-domain', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const embed = topicEmbedder();
    await seed(
      store,
      [
        ada(),
        ada({ subject: 'Ad says a miracle remedy cures pain', reason: 'No study cited.' }),
        ada({
          subject: 'Function returns null instead of throwing',
          domain: 'code-review',
          by: 'cy',
          verdict: 'rejected',
          reason: 'Throw, do not return null.',
        }),
      ],
      embed,
    );
    const heldOut = [
      ada({ subject: 'Reel says a vitamin cures colds' }), // rejected: agrees
      ada({ subject: 'Post says a remedy cures acne', verdict: 'approved' }), // disagrees
      ada({ subject: 'Unrelated cat picture' }), // far: not predicted
      ada({ subject: 'Refactor: code returns null', domain: 'code-review', by: 'cy' }),
    ];
    const report = await evaluateJudgments(
      heldOut,
      { store, grant: grantOf(), embed, decide: decider('rejected', 0.75).decide, now: NOW },
      { thresholds: [0.5, 0.8] },
    );
    expect(report.thresholds).toEqual([0.5, 0.8]);
    expect(report.similarity).toBe('dense');
    expect(report.domains['content']).toEqual({
      items: 3,
      why: { 'too-far': 1 },
      points: [
        { threshold: 0.5, coverage: 0.667, agreement: 0.5, predicted: 2, agreed: 1 },
        { threshold: 0.8, coverage: 0, agreement: null, predicted: 0, agreed: 0 },
      ],
    });
    expect(report.domains['code-review']!.points[0]).toMatchObject({ coverage: 1, agreement: 1 });
    expect(report.domains['(all)']!.items).toBe(4);
    // Nothing was recorded.
    expect(await store.list(grantOf())).toHaveLength(3);
  });
});

/** Built at runtime, so no literal bidi control sits in this file. */
const RLO = String.fromCharCode(0x202e);

/** A pack written by hand: lines as given, the digest computed honestly over `meta` and them. */
function forgePack(
  meta: PackMeta,
  lines: Record<string, unknown>[],
  over: Record<string, unknown> = {},
): string {
  const body = lines.map((l) => JSON.stringify(l));
  const js = lines.map((l) => l['judgment'] as { domain: string; by: string });
  const manifest = {
    oort: 'judgment-pack',
    version: 1,
    ...meta,
    count: body.length,
    digest: packDigest(meta, body),
    domains: [...new Set(js.map((j) => j.domain))].sort(),
    experts: [...new Set(js.map((j) => j.by))].sort(),
    ...over,
  };
  return [JSON.stringify(manifest), ...body].join('\n') + '\n';
}

const META: PackMeta = { name: 'pack', exportedAt: NOW.toISOString(), exportedBy: 'mallory' };
const packLine = (
  id: string,
  over: Partial<JudgmentInput> = {},
  extra: Record<string, unknown> = {},
) => {
  const j = ada(over);
  return {
    id,
    judgment: {
      subject: { summary: j.subject },
      verdict: j.verdict,
      verdicts: ['approved', 'rejected'],
      reason: j.reason,
      criteria: j.criteria,
      domain: j.domain,
      by: j.by,
      decidedAt: j.decidedAt,
      via: 'cli',
      ...extra,
    },
  };
};
const claim = (over: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaaaaaaaaaa',
  name: 'the official ada pack',
  exportedAt: '2026-01-01T00:00:00.000Z',
  exportedBy: 'ada',
  originalId: 'orig-1',
  importedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});

describe('judgment memory: pack security', () => {
  it('judgment.pack-refuses-a-malformed-claimed-origin', () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...claim(), extra: 'x' }, /exactly/],
      [{ ...claim(), name: undefined }, /exactly|plain text/],
      [claim({ name: `ada${RLO}kcap` }), /pack.name must be one line of plain text/],
      [claim({ exportedBy: 'ada\u0007' }), /pack.exportedBy/],
      [claim({ originalId: 'x'.repeat(500) }), /pack.originalId/],
      [claim({ exportedAt: 'yesterday' }), /pack.exportedAt is not an ISO time/],
      [claim({ id: 7 }), /pack.id/],
    ];
    for (const [pack, re] of bad) {
      const text = forgePack(META, [packLine('l1', {}, { pack })]);
      expect(() => parseJudgmentPack(text), re.source).toThrow(re);
    }
    // An expert id with a bidi control is refused like any other bad judgment.
    expect(() => parseJudgmentPack(forgePack(META, [packLine('l1', { by: `ada${RLO}` })]))).toThrow(
      /bidi/,
    );
  });

  it('judgment.pack-origin-comes-from-the-pack-not-the-line', async () => {
    const to = createMemoryStore({ now: () => NOW });
    const deps = { store: to, grant: grantOf(), scope: SCOPE, now: NOW };
    const pack = parseJudgmentPack(forgePack(META, [packLine('l1', {}, { pack: claim() })]));
    const r = await importJudgmentPack(pack, deps);
    expect(r.added).toHaveLength(1);
    const m = (await to.get(grantOf(), r.added[0]!))!;
    // Stored origin: this pack's digest id, its digest-bound metadata, the line's id.
    expect(m.judgment!.pack).toEqual({
      id: pack.manifest.digest.slice(0, 16),
      name: 'pack',
      exportedAt: NOW.toISOString(),
      exportedBy: 'mallory',
      originalId: 'l1',
      importedAt: NOW.toISOString(),
      // The line's claim, kept apart and marked untrusted (importedAt is not carried over).
      claimedEarlier: {
        untrusted: true,
        id: 'aaaaaaaaaaaaaaaa',
        name: 'the official ada pack',
        exportedAt: '2026-01-01T00:00:00.000Z',
        exportedBy: 'ada',
        originalId: 'orig-1',
      },
    });
    // Unknown fields on a line never reach the store.
    const odd = parseJudgmentPack(
      forgePack(META, [
        packLine('l9', { subject: 'Another post' }, { withdrawn: { at: 'x', by: 'y' }, evil: 1 }),
      ]),
    );
    expect(odd.lines[0]!.judgment).not.toHaveProperty('withdrawn');
    expect(odd.lines[0]!.judgment).not.toHaveProperty('evil');
  });

  it('judgment.pack-dedup-ignores-claimed-origins', async () => {
    const to = createMemoryStore({ now: () => NOW });
    const deps = { store: to, grant: grantOf(), scope: SCOPE, now: NOW };
    // First pack: a genuine judgment, which records its origin as (digest id, l1).
    const first = parseJudgmentPack(forgePack(META, [packLine('l1')]));
    await importJudgmentPack(first, deps);
    const firstId = first.manifest.digest.slice(0, 16);
    // A second pack claims that very origin for a different decision. Before, the claim alone made
    // the import skip it (a way to suppress judgments); now the claim is ignored.
    const second = parseJudgmentPack(
      forgePack({ ...META, name: 'other' }, [
        packLine(
          'x',
          { subject: 'A different post', verdict: 'approved', reason: 'Fine.' },
          {
            pack: claim({ id: firstId, originalId: 'l1' }),
          },
        ),
      ]),
    );
    expect((await importJudgmentPack(second, deps)).added).toHaveLength(1);
    // The same decision under a new pack (a re-export) is still recognised, by what it says.
    const reexport = parseJudgmentPack(forgePack({ ...META, name: 'again' }, [packLine('zz')]));
    expect(await importJudgmentPack(reexport, deps)).toEqual({ added: [], skipped: ['zz'] });
    // Withdrawn here: no pack, whatever it claims, brings it back.
    const kept = (await to.list(grantOf())).find((m) => m.judgment?.pack?.originalId === 'l1')!;
    await withdrawJudgment(to, grantOf(), kept, 'ada', NOW);
    const third = parseJudgmentPack(
      forgePack({ ...META, name: 'third' }, [packLine('q', {}, { pack: claim({ id: 'ffff' }) })]),
    );
    expect((await importJudgmentPack(third, deps)).added).toEqual([]);
  });

  it('judgment.pack-manifest-metadata-is-bound-to-the-content', () => {
    const honest = forgePack(META, [packLine('l1')]);
    expect(parseJudgmentPack(honest).manifest).toMatchObject({
      name: 'pack',
      exportedBy: 'mallory',
      domains: ['content'],
      experts: ['ada'],
    });
    const [head, ...rest] = honest.trim().split('\n');
    const m = JSON.parse(head!) as Record<string, unknown>;
    // Name, exporter or time changed after the fact: the digest no longer matches.
    for (const over of [
      { name: 'Official Legal Pack' },
      { exportedBy: 'ada' },
      { exportedAt: '2020-01-01T00:00:00.000Z' },
    ]) {
      expect(() =>
        parseJudgmentPack([JSON.stringify({ ...m, ...over }), ...rest].join('\n')),
      ).toThrow(/digest/);
    }
    // Domains and experts must be the lines' own, whatever the digest says.
    expect(() =>
      parseJudgmentPack(forgePack(META, [packLine('l1')], { experts: ['the-chief-justice'] })),
    ).toThrow(/domains or experts do not match/);
    expect(() =>
      parseJudgmentPack(forgePack(META, [packLine('l1')], { domains: ['content', 'legal'] })),
    ).toThrow(/domains or experts do not match/);
    // Metadata a person reads is plain text with length caps.
    for (const meta of [
      { ...META, name: `pack${RLO}` },
      { ...META, name: 'x'.repeat(200) },
      { ...META, exportedBy: 'a\nb' },
      { ...META, exportedAt: 'soon' },
    ]) {
      expect(() => parseJudgmentPack(forgePack(meta, [packLine('l1')]))).toThrow(JudgmentPackError);
    }
  });

  it('judgment.imported-experts-count-only-when-asked', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const embed = topicEmbedder();
    await importJudgmentPack(parseJudgmentPack(forgePack(META, [packLine('l1')])), {
      store,
      grant: grantOf(),
      scope: SCOPE,
      embed,
      now: NOW,
    });
    const d = decider('rejected', 0.9);
    const deps = { store, grant: grantOf(), embed, decide: d.decide, now: NOW };
    const item = { summary: 'A vitamin cures colds', domain: 'content' };
    const local = await judge(item, deps);
    expect(local).toMatchObject({
      status: 'needs-expert',
      why: 'no-precedents',
      importedExcluded: 1,
    });
    expect(d.asked).toEqual([]);
    const withImported = await judge(item, deps, { includeImported: true });
    expect(withImported.status).toBe('suggested');
    expect(withImported.importedExcluded).toBeUndefined();
    expect(withImported.precedents[0]).toMatchObject({
      by: 'ada',
      imported: true,
      pack: { name: 'pack' },
    });
    // A local record of the same item never corrects the imported judgment: it is its own.
    const r = await recordJudgment(ada({ verdict: 'approved', reason: 'Local view.' }), {
      store,
      grant: grantOf(),
      scope: SCOPE,
      now: NOW,
      via: 'cli',
    });
    expect(r.outcome).toBe('added');
    expect((await judge(item, deps)).precedents.map((p) => p.imported)).toEqual([undefined]);
  });
});
