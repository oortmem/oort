import { filterFor } from '@oortmem/claude-code';
import { activation, type Memory, type MemoryStore } from '@oortmem/core';
import {
  Refusal,
  age,
  clip,
  findMemory,
  fixed,
  short,
  table,
  withoutEmbedding,
  withWired,
  type Ctx,
} from '../util.js';

export interface InspectOptions {
  json?: boolean;
  limit?: string;
}

export interface ChainLink {
  id: string;
  validFrom: string;
  validTo: string | null;
  expiredAt: string | null;
  endReason: Memory['endReason'];
  text: string;
}

const link = (m: Memory): ChainLink => ({
  id: m.id,
  validFrom: m.validFrom,
  validTo: m.validTo,
  expiredAt: m.expiredAt,
  endReason: m.endReason,
  text: m.text,
});

/** The supersede chain through `m`, oldest first: `supersedes` back, `supersededBy` forward. */
export async function supersedeChain(store: MemoryStore, m: Memory): Promise<ChainLink[]> {
  const seen = new Set([m.id]);
  const back: ChainLink[] = [];
  for (let id = m.supersedes; id !== null && !seen.has(id);) {
    seen.add(id);
    const prior = await store.get(id);
    if (prior === null) break;
    back.unshift(link(prior));
    id = prior.supersedes;
  }
  const forward: ChainLink[] = [];
  for (let id = m.supersededBy; id !== null && !seen.has(id);) {
    seen.add(id);
    const next = await store.get(id);
    if (next === null) break;
    forward.push(link(next));
    id = next.supersededBy;
  }
  return [...back, link(m), ...forward];
}

function limitOf(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Refusal(`--limit "${raw}" is not a positive integer.`);
  return n;
}

/** `oort inspect [<id>] [--json] [--limit n]` */
export async function inspectCommand(
  id: string | undefined,
  opts: InspectOptions,
  ctx: Ctx,
): Promise<number> {
  const limit = limitOf(opts.limit);
  return withWired(ctx, async (w) => {
    const now = new Date();
    const filter = filterFor(w.scope);
    if (id === undefined) {
      const current = (await w.store.list(filter)).slice(0, limit);
      if (opts.json === true) {
        ctx.io.out(`${JSON.stringify(current.map(withoutEmbedding), null, 2)}\n`);
        return 0;
      }
      const rows = current.map((m) => [
        short(m.id),
        m.type,
        m.tier,
        fixed(activation(m.accessLog, m.salience, now, w.config.activation)),
        age(m.validFrom, now),
        clip(m.text, 60),
      ]);
      ctx.io.out(table(['id', 'type', 'tier', 'activation', 'age', 'text'], rows));
      return 0;
    }
    const m = await findMemory(w.store, filter, id);
    const chain = await supersedeChain(w.store, m);
    if (opts.json === true) {
      ctx.io.out(`${JSON.stringify({ memory: withoutEmbedding(m), chain }, null, 2)}\n`);
      return 0;
    }
    const a = activation(m.accessLog, m.salience, now, w.config.activation);
    const lines = [
      `id          ${m.id}`,
      `type        ${m.type}`,
      `tier        ${m.tier}${m.pinned ? ' (pinned)' : ''}`,
      `scope       ${JSON.stringify(m.scope)}`,
      `salience    ${fixed(m.salience)}`,
      `activation  ${fixed(a)} (${m.accessLog.count} accesses)`,
      `valid       ${m.validFrom} → ${m.validTo ?? 'open'}`,
      `expired     ${m.expiredAt ?? 'no'}${m.endReason !== null ? ` (${m.endReason})` : ''}`,
      `confirmed   ${m.lastConfirmedAt ?? 'never'}`,
      `created     ${m.createdAt}`,
      `updated     ${m.updatedAt}`,
      `source      ${m.source.harness}${m.source.sessionId !== undefined ? ` session ${m.source.sessionId}` : ''}${m.source.turnRef !== undefined ? ` turn ${m.source.turnRef}` : ''}`,
      `embedding   ${m.embedding !== undefined ? `${m.embedding.length} dims` : 'none'}`,
      `stub        ${m.stub}`,
      `entities    ${m.entities.join(', ') || '-'}`,
      '',
      m.text,
      '',
      'decisions',
    ];
    ctx.io.out(`${lines.join('\n')}\n`);
    ctx.io.out(
      table(
        ['stage', 'question', 'answer', 'p'],
        m.source.decisions.map((d) => [d.stage, d.question, d.answer, fixed(d.probability, 3)]),
      ),
    );
    ctx.io.out('\nsupersede chain (oldest first)\n');
    ctx.io.out(
      table(
        ['', 'id', 'valid from', 'valid to', 'end', 'text'],
        chain.map((c) => [
          c.id === m.id ? '*' : '',
          short(c.id),
          c.validFrom,
          c.validTo ?? 'open',
          c.endReason ?? '-',
          clip(c.text, 60),
        ]),
      ),
    );
    return 0;
  });
}
