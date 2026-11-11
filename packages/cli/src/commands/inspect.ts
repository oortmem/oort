import { filterFor } from '@oortmem/claude-code';
import { activation, localGrant, type Memory } from '@oortmem/core';
import { OortCloudError, findCloudMemory, type CloudClient } from '../cloud.js';
import { chainLink, supersedeChain, type ChainLink } from '../engine/chain.js';
import { emit, jsonMode } from '../output.js';
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
  shown,
  when,
  withoutEmbedding,
  withWired,
  type Ctx,
} from '../util.js';

export interface InspectOptions {
  json?: boolean;
  limit?: string;
}

// Moved to the UI-free engine (CON-108).
export { supersedeChain, type ChainLink } from '../engine/chain.js';

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
      add(chainLink(x));
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
  return { links: [...back, chainLink(m), ...forward], hidden };
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
      if (jsonMode(ctx)) {
        const shaped =
          cloud !== undefined
            ? current
            : await Promise.all(current.map((m) => shapeLinks(w.store, filter, m)));
        emit(ctx, { memories: shaped.map(withoutEmbedding) });
        return 0;
      }
      const ui = uiFor(ctx.io);
      const rows = current.map((m) => [
        short(m.id),
        m.type,
        ui.tier(m.tier),
        fixed(activation(m.accessLog, m.salience, now, w.config.activation)),
        age(m.validFrom, now),
        shown(clip(m.text, 60)),
      ]);
      const n = current.length;
      ctx.io.out(
        ui.header('inspect', `${n} current ${n === 1 ? 'memory' : 'memories'}`, scopeLabel(w)),
      );
      if (n === 0) {
        ctx.io.out(
          `${ui.info('No memories here yet. Your agent saves them as you work; `oort import claude-code` brings in past sessions.')}\n`,
        );
        return 0;
      }
      ctx.io.out(ui.table(['id', 'type', 'tier', 'activation', 'age', 'text'], rows));
      return 0;
    }
    const m =
      cloud !== undefined
        ? ((await findCloudMemory(cloud, id)) as Memory)
        : await findMemory(w.store, filter, id);
    const { links: chain, hidden } =
      cloud !== undefined ? await cloudChain(cloud, m) : await supersedeChain(w.store, m, filter);
    if (jsonMode(ctx)) {
      const memory = withoutEmbedding(
        cloud !== undefined ? m : await shapeLinks(w.store, filter, m),
      );
      emit(ctx, { memory, chain, hiddenLinks: hidden });
      return 0;
    }
    const a = activation(m.accessLog, m.salience, now, w.config.activation);
    const ui = uiFor(ctx.io);
    ctx.io.out(ui.header('inspect', short(m.id), scopeLabel(w)));
    ctx.io.out(
      ui.kv([
        ['id', shown(m.id)],
        ['type', m.type],
        ['tier', `${ui.tier(m.tier)}${m.pinned ? ' (pinned)' : ''}`],
        ['scope', shown(JSON.stringify(m.scope))],
        ['salience', fixed(m.salience)],
        ['activation', `${fixed(a)} (${m.accessLog.count} accesses)`],
        [
          'valid',
          `${when(m.validFrom, now)} → ${m.validTo === null ? 'open' : when(m.validTo, now)}`,
        ],
        [
          'expired',
          `${m.expiredAt === null ? 'no' : when(m.expiredAt, now)}${m.endReason !== null ? ` (${m.endReason})` : ''}`,
        ],
        ['confirmed', m.lastConfirmedAt === null ? 'never' : when(m.lastConfirmedAt, now)],
        ['created', when(m.createdAt, now)],
        ['updated', when(m.updatedAt, now)],
        [
          'source',
          shown(
            `${m.source.harness}${m.source.sessionId !== undefined ? ` session ${m.source.sessionId}` : ''}${m.source.turnRef !== undefined ? ` turn ${m.source.turnRef}` : ''}`,
          ),
        ],
        ['embedding', m.embedding !== undefined ? `${m.embedding.length} dims` : 'none'],
        ['stub', shown(m.stub)],
        ['entities', shown(m.entities.join(', ')) || '-'],
      ]),
    );
    ctx.io.out(`\n${shown(m.text, { newlines: true })}\n\n${ui.bold('decisions')}\n`);
    ctx.io.out(
      ui.table(
        ['stage', 'question', 'answer', 'p'],
        (cloud !== undefined ? m : await shapeLinks(w.store, filter, m)).source.decisions.map(
          (d) => [shown(d.stage), shown(d.question), shown(d.answer), fixed(d.probability, 3)],
        ),
      ),
    );
    ctx.io.out(`\n${ui.bold('supersede chain')} ${ui.dim('(oldest first)')}\n`);
    ctx.io.out(
      ui.table(
        ['', 'id', 'valid from', 'valid to', 'end', 'text'],
        chain.map((c) => [
          c.id === m.id ? '*' : '',
          shown(short(c.id)),
          when(c.validFrom, now, { short: true }),
          c.validTo === null ? 'open' : when(c.validTo, now, { short: true }),
          c.endReason ?? '-',
          shown(clip(c.text, 60)),
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
