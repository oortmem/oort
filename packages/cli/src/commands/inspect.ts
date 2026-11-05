import { filterFor } from '@oortmem/claude-code';
import {
  activation,
  localGrant,
  type Memory,
  type MemoryStore,
  type ScopeFilter,
} from '@oortmem/core';
import { OortCloudError, findCloudMemory, type CloudClient } from '../cloud.js';
import { uiFor } from '../ui.js';
import {
  Refusal,
  cloudOf,
  echo,
  age,
  clip,
  findMemory,
  fixed,
  scopeLabel,
  shapeLinks,
  short,
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

/**
 * The supersede chain through `m`, oldest first: `supersedes` back,
 * `supersededBy` forward. Links outside `filter` (another project's memory,
 * from before observe kept chains in one scope) are walked through but not
 * returned; `hidden` counts them.
 */
export async function supersedeChain(
  store: MemoryStore,
  m: Memory,
  filter: ScopeFilter,
): Promise<{ links: ChainLink[]; hidden: number }> {
  const grant = localGrant(filter);
  const seen = new Set([m.id]);
  let hidden = 0;
  const walk = async (
    start: string | null,
    next: (x: Memory) => string | null,
    add: (l: ChainLink) => void,
  ): Promise<void> => {
    for (let id = start; id !== null && !seen.has(id);) {
      seen.add(id);
      // The store answers an unknown and an out-of-scope id alike: the chain
      // continues where this view cannot follow, so the walk stops there.
      const x = await store.get(grant, id);
      if (x === null) {
        hidden++;
        break;
      }
      add(link(x));
      id = next(x);
    }
  };
  const back: ChainLink[] = [];
  const forward: ChainLink[] = [];
  await walk(
    m.supersedes,
    (x) => x.supersedes,
    (l) => back.unshift(l),
  );
  await walk(
    m.supersededBy,
    (x) => x.supersededBy,
    (l) => forward.push(l),
  );
  return { links: [...back, link(m), ...forward], hidden };
}

/** The supersede chain through `m` in Oort Cloud: links the account cannot read count as hidden. */
async function cloudChain(
  client: CloudClient,
  m: Memory,
): Promise<{ links: ChainLink[]; hidden: number }> {
  const seen = new Set([m.id]);
  let hidden = 0;
  const walk = async (
    start: string | null,
    next: (x: Memory) => string | null,
    add: (l: ChainLink) => void,
  ): Promise<void> => {
    for (let id = start; id !== null && !seen.has(id);) {
      seen.add(id);
      let x: Memory;
      try {
        x = (await client.get(id)) as Memory;
      } catch (e) {
        if (e instanceof OortCloudError && e.kind === 'not-found') {
          hidden++;
          break;
        }
        throw e;
      }
      add(link(x));
      id = next(x);
    }
  };
  const back: ChainLink[] = [];
  const forward: ChainLink[] = [];
  await walk(
    m.supersedes,
    (x) => x.supersedes,
    (l) => back.unshift(l),
  );
  await walk(
    m.supersededBy,
    (x) => x.supersededBy,
    (l) => forward.push(l),
  );
  return { links: [...back, link(m), ...forward], hidden };
}

function limitOf(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Refusal(`--limit ${echo(raw)} is not a positive integer.`);
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
    const cloud = cloudOf(w);
    const project = w.scope.projectId;
    if (id === undefined) {
      const current =
        cloud !== undefined
          ? ((
              await cloud.list({
                ...(project !== undefined && { project }),
                limit: Math.min(limit, 100),
              })
            ).memories as Memory[])
          : (await w.store.list(localGrant(filter))).slice(0, limit);
      if (opts.json === true) {
        const shaped =
          cloud !== undefined
            ? current
            : await Promise.all(current.map((m) => shapeLinks(w.store, filter, m)));
        ctx.io.out(`${JSON.stringify(shaped.map(withoutEmbedding), null, 2)}\n`);
        return 0;
      }
      const ui = uiFor(ctx.io);
      const rows = current.map((m) => [
        short(m.id),
        m.type,
        ui.tier(m.tier),
        fixed(activation(m.accessLog, m.salience, now, w.config.activation)),
        age(m.validFrom, now),
        clip(m.text, 60),
      ]);
      const n = current.length;
      ctx.io.out(
        ui.header('inspect', `${n} current ${n === 1 ? 'memory' : 'memories'}`, scopeLabel(w)),
      );
      ctx.io.out(ui.table(['id', 'type', 'tier', 'activation', 'age', 'text'], rows));
      return 0;
    }
    const m =
      cloud !== undefined
        ? ((await findCloudMemory(cloud, id)) as Memory)
        : await findMemory(w.store, filter, id);
    const { links: chain, hidden } =
      cloud !== undefined ? await cloudChain(cloud, m) : await supersedeChain(w.store, m, filter);
    if (opts.json === true) {
      const memory = withoutEmbedding(
        cloud !== undefined ? m : await shapeLinks(w.store, filter, m),
      );
      const out = { memory, chain, hiddenLinks: hidden };
      ctx.io.out(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }
    const a = activation(m.accessLog, m.salience, now, w.config.activation);
    const ui = uiFor(ctx.io);
    ctx.io.out(ui.header('inspect', short(m.id), scopeLabel(w)));
    ctx.io.out(
      ui.kv([
        ['id', m.id],
        ['type', m.type],
        ['tier', `${ui.tier(m.tier)}${m.pinned ? ' (pinned)' : ''}`],
        ['scope', JSON.stringify(m.scope)],
        ['salience', fixed(m.salience)],
        ['activation', `${fixed(a)} (${m.accessLog.count} accesses)`],
        ['valid', `${m.validFrom} → ${m.validTo ?? 'open'}`],
        ['expired', `${m.expiredAt ?? 'no'}${m.endReason !== null ? ` (${m.endReason})` : ''}`],
        ['confirmed', m.lastConfirmedAt ?? 'never'],
        ['created', m.createdAt],
        ['updated', m.updatedAt],
        [
          'source',
          `${m.source.harness}${m.source.sessionId !== undefined ? ` session ${m.source.sessionId}` : ''}${m.source.turnRef !== undefined ? ` turn ${m.source.turnRef}` : ''}`,
        ],
        ['embedding', m.embedding !== undefined ? `${m.embedding.length} dims` : 'none'],
        ['stub', m.stub],
        ['entities', m.entities.join(', ') || '-'],
      ]),
    );
    ctx.io.out(`\n${m.text}\n\n${ui.bold('decisions')}\n`);
    ctx.io.out(
      ui.table(
        ['stage', 'question', 'answer', 'p'],
        (cloud !== undefined ? m : await shapeLinks(w.store, filter, m)).source.decisions.map(
          (d) => [d.stage, d.question, d.answer, fixed(d.probability, 3)],
        ),
      ),
    );
    ctx.io.out(`\n${ui.bold('supersede chain')} ${ui.dim('(oldest first)')}\n`);
    ctx.io.out(
      ui.table(
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
    if (hidden > 0) {
      ctx.io.out(
        `${hidden} linked ${hidden === 1 ? 'memory' : 'memories'} in another scope (not shown)\n`,
      );
    }
    return 0;
  });
}
