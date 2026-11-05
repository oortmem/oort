import type { DecisionController, Memory, Observation, ReconcileAction } from '@oortmem/core';

/**
 * The decision eval: labelled gate, reconcile and novel questions (eval/decisions.jsonl) put to
 * a decision controller, scored per question type. Recall rows in the main eval are seeded, so
 * they do not depend on the controller; this is where Jev and the local decider are compared.
 */

export type DecisionRow =
  | {
      kind: 'gate';
      user: string;
      assistant: string;
      tools?: string[];
      expect: { store: boolean; type?: string; volatile?: boolean };
    }
  | {
      kind: 'reconcile';
      fact: string;
      candidate: { text: string; validFrom: string };
      expect: ReconcileAction;
    }
  | { kind: 'novel'; fact: string; expect: 'ADD' | 'NOOP' };

export function loadDecisionRows(text: string): DecisionRow[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      const r = JSON.parse(l) as DecisionRow;
      if (r.kind !== 'gate' && r.kind !== 'reconcile' && r.kind !== 'novel') {
        throw new Error(`decisions line ${i + 1}: unknown kind`);
      }
      return r;
    });
}

/** The turn time every row is asked at. */
const AT = '2026-11-05T10:00:00Z';

const REWRITES = new Set<string>(['REFINE', 'UPDATE', 'SUPERSEDE', 'CORRECT']);
const ENDS = new Set<string>(['SUPERSEDE', 'CORRECT']);

function obsOf(r: DecisionRow): Observation {
  if (r.kind === 'gate') {
    return { userText: r.user, assistantText: r.assistant, toolSummaries: r.tools ?? [], at: AT };
  }
  return { userText: r.fact, assistantText: '', toolSummaries: [], at: AT };
}

function memoryOf(c: { text: string; validFrom: string }): Memory {
  return {
    id: 'candidate',
    text: c.text,
    stub: c.text,
    entities: [],
    type: 'semantic',
    validFrom: c.validFrom,
  } as unknown as Memory;
}

export interface Ratio {
  correct: number;
  total: number;
}

export interface DecisionReport {
  decider: string;
  gate: { store: Ratio; type: Ratio; volatile: Ratio; falseStore: Ratio; missedStore: Ratio };
  /** Per expected action: how often it was chosen. */
  reconcile: Record<string, Ratio>;
  reconcileOverall: Ratio;
  /**
   * Rows whose memory must stay as it is (NOOP, REINFORCE, ADD) answered with a rewrite: a wrong
   * REFINE rewrites a true memory, a wrong SUPERSEDE or CORRECT ends it.
   */
  wrongRewrite: Ratio;
  /** Of those rows, answered SUPERSEDE or CORRECT: the true memory would be ended. */
  wrongEnd: Ratio;
  /** Rewrite rows (REFINE, SUPERSEDE, CORRECT) answered with something that keeps the old text. */
  missedRewrite: Ratio;
  novel: Ratio;
  /** Expected -> answered -> count. */
  confusion: Record<string, Record<string, number>>;
  /** Wall time per call in ms, by kind. */
  latencyMs: Record<'gate' | 'reconcile' | 'novel', { p50: number; p95: number; max: number }>;
}

const ratio = (): Ratio => ({ correct: 0, total: 0 });
const add = (r: Ratio, ok: boolean): void => {
  r.total++;
  if (ok) r.correct++;
};

function quantiles(xs: number[]) {
  if (xs.length === 0) return { p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { p50: q(0.5), p95: q(0.95), max: s.at(-1)! };
}

export async function runDecisionEval(
  decider: string,
  controller: DecisionController,
  rows: DecisionRow[],
  onRow?: (i: number) => void,
): Promise<DecisionReport> {
  const rep: DecisionReport = {
    decider,
    gate: {
      store: ratio(),
      type: ratio(),
      volatile: ratio(),
      falseStore: ratio(),
      missedStore: ratio(),
    },
    reconcile: {},
    reconcileOverall: ratio(),
    wrongRewrite: ratio(),
    wrongEnd: ratio(),
    missedRewrite: ratio(),
    novel: ratio(),
    confusion: {},
    latencyMs: {
      gate: { p50: 0, p95: 0, max: 0 },
      reconcile: { p50: 0, p95: 0, max: 0 },
      novel: { p50: 0, p95: 0, max: 0 },
    },
  };
  const times: Record<'gate' | 'reconcile' | 'novel', number[]> = {
    gate: [],
    reconcile: [],
    novel: [],
  };
  for (const [i, r] of rows.entries()) {
    onRow?.(i);
    const t0 = performance.now();
    if (r.kind === 'gate') {
      const g = await controller.gate(obsOf(r));
      times.gate.push(performance.now() - t0);
      const stored = g.shouldStore >= 0.5;
      add(rep.gate.store, stored === r.expect.store);
      if (!r.expect.store) add(rep.gate.falseStore, !stored);
      else add(rep.gate.missedStore, stored);
      if (r.expect.type !== undefined) {
        const entries = Object.entries(g.types);
        const best = entries.reduce<[string, number] | undefined>(
          (b, e) => (b === undefined || (e[1] ?? 0) > b[1] ? [e[0], e[1] ?? 0] : b),
          undefined,
        );
        add(rep.gate.type, best?.[0] === r.expect.type);
      }
      if (r.expect.volatile !== undefined && g.volatile !== undefined) {
        add(rep.gate.volatile, g.volatile >= 0.5 === r.expect.volatile);
      }
      continue;
    }
    const [d] = await controller.reconcile(
      obsOf(r),
      r.kind === 'reconcile' ? [memoryOf(r.candidate)] : [],
    );
    const ms = performance.now() - t0;
    const got = d?.action === 'UPDATE' ? 'REFINE' : (d?.action ?? 'none');
    if (r.kind === 'novel') {
      times.novel.push(ms);
      add(rep.novel, got === r.expect);
      continue;
    }
    times.reconcile.push(ms);
    (rep.confusion[r.expect] ??= {})[got] = (rep.confusion[r.expect]![got] ?? 0) + 1;
    add((rep.reconcile[r.expect] ??= ratio()), got === r.expect);
    add(rep.reconcileOverall, got === r.expect);
    if (REWRITES.has(r.expect)) add(rep.missedRewrite, !REWRITES.has(got));
    else {
      // Counted as "correct" when no rewrite happened, so the rate is 1 - correct/total.
      add(rep.wrongRewrite, !REWRITES.has(got));
      add(rep.wrongEnd, !ENDS.has(got));
    }
  }
  for (const k of ['gate', 'reconcile', 'novel'] as const) rep.latencyMs[k] = quantiles(times[k]);
  return rep;
}

const pct = (r: Ratio, invert = false): string => {
  if (r.total === 0) return '-';
  const v = invert ? 1 - r.correct / r.total : r.correct / r.total;
  return `${(v * 100).toFixed(0)}% (${invert ? r.total - r.correct : r.correct}/${r.total})`;
};

/** A Markdown table, one column per decider. */
export function renderDecisionReports(reps: DecisionReport[]): string {
  const rows: [string, (r: DecisionReport) => string][] = [
    ['gate: should store', (r) => pct(r.gate.store)],
    ['gate: kept a not-worth turn out', (r) => pct(r.gate.falseStore)],
    ['gate: stored a worth turn', (r) => pct(r.gate.missedStore)],
    ['gate: type (argmax)', (r) => pct(r.gate.type)],
    ['gate: volatile', (r) => pct(r.gate.volatile)],
    ['reconcile: overall', (r) => pct(r.reconcileOverall)],
    ...(['NOOP', 'REINFORCE', 'REFINE', 'SUPERSEDE', 'CORRECT', 'ADD'] as const).map(
      (a): [string, (r: DecisionReport) => string] => [
        `reconcile: ${a}`,
        (r) => pct(r.reconcile[a] ?? ratio()),
      ],
    ),
    ['wrong rewrite (lower is better)', (r) => pct(r.wrongRewrite, true)],
    ['wrong end of a true memory (lower is better)', (r) => pct(r.wrongEnd, true)],
    ['missed rewrite (lower is better)', (r) => pct(r.missedRewrite)],
    ['novel (no candidates)', (r) => pct(r.novel)],
    [
      'gate ms p50 / p95',
      (r) => `${r.latencyMs.gate.p50.toFixed(0)} / ${r.latencyMs.gate.p95.toFixed(0)}`,
    ],
    [
      'reconcile ms p50 / p95',
      (r) => `${r.latencyMs.reconcile.p50.toFixed(0)} / ${r.latencyMs.reconcile.p95.toFixed(0)}`,
    ],
  ];
  const head = ['Question', ...reps.map((r) => r.decider)];
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map(([name, f]) => `| ${[name, ...reps.map(f)].join(' | ')} |`),
  ].join('\n');
}
