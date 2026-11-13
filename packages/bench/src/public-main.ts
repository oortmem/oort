/**
 * `pnpm eval --set locomo|longmemeval` (CON-147): see `eval/public/README.md`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, resolveHome, type Embedder, type Reranker } from '@oortmem/core';
import { voyageEmbedder } from '@oortmem/embed-voyage';
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  localEmbedder,
  localReranker,
} from '@oortmem/local-models';
import { voyageReranker } from '@oortmem/rerank-voyage';
import {
  CACHE_DIR,
  checkDataset,
  DATASETS,
  datasetPath,
  fetchDataset,
  type DatasetName,
} from './datasets.js';
import { cachingEmbedder, type CachingEmbedder } from './embed-cache.js';
import { cell, renderReport } from './eval.js';
import { fakeEmbedder } from './fake-embed.js';
import { EMBEDDING_DIMENSION } from './generate.js';
import { linkModesFor } from './links.js';
import { loadLocomo } from './locomo.js';
import { loadLongMemEval } from './longmemeval.js';
import {
  estimateTokens,
  planPublicSet,
  renderPlan,
  tokenizerCounter,
  type TokenCounter,
} from './public-plan.js';
import { runPublicSet, type PublicReport, type PublicSet } from './public-sets.js';

export interface PublicArgs {
  set: DatasetName;
  file?: string;
  fetch: boolean;
  /** Run a file that is not the pinned revision, or one given by path (recorded as unpinned). */
  unpinned: boolean;
  plan: boolean;
  yes: boolean;
  embed: string;
  rerank: string;
  limit?: string;
  links: string;
  noGate: boolean;
  k: string;
  json: boolean;
  out?: string;
  home?: string;
  tokenizer?: string;
  cacheDir?: string;
}

const VERSION = (
  JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as {
    version: string;
  }
).version;

/**
 * `limit` items spread evenly through `xs` (the first, then every `xs.length / limit`-th), so a
 * limited run of a file sorted by category still covers every category.
 */
export function spread<T>(xs: T[], limit: number): T[] {
  if (limit >= xs.length) return xs;
  return Array.from({ length: limit }, (_, i) => xs[Math.floor((i * xs.length) / limit)] as T);
}

export function loadSet(name: DatasetName, file: string, limit?: number): PublicSet {
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const set = name === 'locomo' ? loadLocomo(json) : loadLongMemEval(json);
  return limit === undefined ? set : { ...set, haystacks: spread(set.haystacks, limit) };
}

interface Models {
  embed?: CachingEmbedder | Embedder;
  rerank?: Reranker;
  embedLabel: string;
  rerankLabel: string;
  paid: { embed?: string; rerank?: string };
  /** For a plan: the embedding cache of the paid model, to count what is already embedded. */
  planCache?: CachingEmbedder;
}

function models(a: PublicArgs, cacheDir: string): Models {
  const home = a.home ?? resolveHome();
  const defaults = resolveConfig(home, { OORT_HOME: home }, { projectConfig: false });
  const [embedKind, embedModel] = a.embed.split(/:(.*)/s) as [string, string | undefined];
  const [rerankKind, rerankModel] = a.rerank.split(/:(.*)/s) as [string, string | undefined];
  const out: Models = { embedLabel: 'none (lexical only)', rerankLabel: 'none', paid: {} };
  const cached = (base: Embedder, model: string): CachingEmbedder =>
    cachingEmbedder(base, {
      model: `${model}@${EMBEDDING_DIMENSION}`,
      file: path.join(cacheDir, 'embeddings', `${model}-${EMBEDDING_DIMENSION}.sqlite`),
    });
  if (embedKind === 'fake') {
    out.embed = fakeEmbedder(EMBEDDING_DIMENSION);
    out.embedLabel = 'fake (bench)';
  } else if (embedKind === 'local') {
    const model = embedModel ?? DEFAULT_EMBED_MODEL;
    out.embed = cached(localEmbedder({ home, model, dimension: EMBEDDING_DIMENSION }), model);
    out.embedLabel = `local ${model}`;
  } else if (embedKind === 'voyage') {
    const model = embedModel ?? defaults.embed.model;
    out.paid.embed = model;
    out.embedLabel = `voyage ${model}`;
    if (a.yes && !a.plan) {
      out.embed = cached(voyageEmbedder({ model, dimension: EMBEDDING_DIMENSION }), model);
    } else {
      out.planCache = cached(
        {
          dimension: EMBEDDING_DIMENSION,
          embed: async () => {
            throw new Error('a plan never embeds');
          },
        },
        model,
      );
    }
  } else if (embedKind !== 'none') throw new Error(`unknown --embed "${a.embed}"`);
  if (rerankKind === 'local') {
    const model = rerankModel ?? DEFAULT_RERANK_MODEL;
    out.rerank = localReranker({ home, model });
    out.rerankLabel = `local ${model}`;
  } else if (rerankKind === 'voyage') {
    const model = rerankModel ?? defaults.rerank.model;
    out.paid.rerank = model;
    out.rerankLabel = `voyage ${model}`;
    if (a.yes && !a.plan) out.rerank = voyageReranker({ model });
  } else if (rerankKind !== 'none') throw new Error(`unknown --rerank "${a.rerank}"`);
  return out;
}

async function counter(a: PublicArgs, cacheDir: string): Promise<TokenCounter> {
  const dir = a.tokenizer ?? path.join(cacheDir, 'tokenizers', 'voyage-3.5-lite');
  return fs.existsSync(path.join(dir, 'tokenizer.json')) ? tokenizerCounter(dir) : estimateTokens;
}

export function renderPublic(r: PublicReport, header: string[]): string {
  const lines = [...header, ''];
  lines.push(`Evidence recall over turns (${r.questions} questions):`, '', renderReport(r.turn));
  if (r.session !== undefined) {
    lines.push('', 'Recall over answer sessions:', '', renderReport(r.session));
  }
  lines.push(
    '',
    `${r.haystacks} haystacks, ${r.turns} turns observed (${r.scrubbed} dropped by the secret scrubber); ${r.droppedQuestions} questions without a readable evidence turn left out, ${r.droppedEvidence} unreadable evidence references dropped. ${(r.ms / 60_000).toFixed(1)} min.`,
  );
  return lines.join('\n');
}

/** Returns the exit code. */
export async function publicMain(a: PublicArgs, log: (m: string) => void): Promise<number> {
  const cacheDir = a.cacheDir ?? CACHE_DIR;
  const src = DATASETS[a.set];
  const ks = a.k.split(',').map((x) => Number(x.trim()));
  if (ks.some((k) => !Number.isInteger(k) || k <= 0))
    throw new Error(`--k must be positive integers`);
  const limit = a.limit !== undefined ? Number(a.limit) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error('--limit must be a positive integer');
  }
  if (a.file !== undefined && !a.unpinned) {
    log(
      `refusing ${a.file}: a file given by path runs only with --unpinned (its numbers are then recorded as unpinned). Use --fetch for the pinned revision.`,
    );
    return 1;
  }
  let file = a.file ?? datasetPath(a.set, cacheDir);
  if (a.fetch) file = await fetchDataset(a.set, { cacheDir, log });
  if (!fs.existsSync(file)) {
    throw new Error(
      `${src.name} is not in the cache (${file}). It is never bundled: fetch it with --fetch (${src.licence}, ${src.url}) or pass a path.`,
    );
  }
  // Checked before the file is parsed: a file that is not the pinned revision is never read
  // unless asked for.
  const check = checkDataset(a.set, file);
  if (!check.pinned) {
    if (!a.unpinned) {
      log(
        `refusing ${file}: SHA-256 ${check.sha256} is not the recorded ${src.sha256} (${src.revision}). Re-fetch with --fetch, or pass --unpinned to run it anyway.`,
      );
      return 1;
    }
    log(`warning: ${file} has SHA-256 ${check.sha256}, not the recorded ${src.sha256}`);
  }
  const set = loadSet(a.set, file, limit);
  const m = models(a, cacheDir);
  const paid = m.paid.embed !== undefined || m.paid.rerank !== undefined;
  if (a.plan || (paid && !a.yes)) {
    const tokens = await counter(a, cacheDir);
    const defaults = resolveConfig(cacheDir, { OORT_HOME: cacheDir }, { projectConfig: false });
    const plan = planPublicSet(set, {
      ...(m.paid.embed !== undefined && { embedModel: m.paid.embed }),
      ...(m.paid.rerank !== undefined && { rerankModel: m.paid.rerank }),
      rerankK: Math.max(defaults.recall.rerankK, ...ks),
      tokens,
      ...(m.planCache !== undefined && {
        cached: (t: string) => (m.planCache as CachingEmbedder).has(t, 'document'),
      }),
    });
    m.planCache?.close();
    process.stdout.write(`${a.json ? JSON.stringify(plan, null, 2) : renderPlan(plan)}\n`);
    if (!a.plan) {
      log('paid models need --yes after reading the plan above: nothing was sent');
      return 2;
    }
    return 0;
  }
  const reports: PublicReport[] = [];
  try {
    for (const links of linkModesFor(a.links)) {
      reports.push(
        await runPublicSet({
          set,
          ks,
          links,
          log,
          ...(a.noGate && { gate: false }),
          ...(m.embed !== undefined && { embed: m.embed }),
          ...(m.rerank !== undefined && { rerank: m.rerank }),
        }),
      );
    }
  } finally {
    if (m.embed !== undefined && 'close' in m.embed) m.embed.close();
  }
  const meta = {
    oort: VERSION,
    dataset: {
      name: src.name,
      revision: src.revision,
      sha256: check.sha256,
      pinned: check.pinned,
      licence: src.licence,
    },
    embed: m.embedLabel,
    rerank: m.rerankLabel,
    gate: !a.noGate,
    limit: limit ?? null,
    ...(m.embed !== undefined && 'usage' in m.embed && { embedUsage: m.embed.usage() }),
  };
  const json = `${JSON.stringify({ ...meta, runs: reports }, null, 2)}\n`;
  if (a.out !== undefined) fs.writeFileSync(a.out, json);
  if (a.json) {
    process.stdout.write(json);
  } else {
    for (const r of reports) {
      process.stdout.write(
        `${renderPublic(r, [
          `${src.name}, ${src.revision}, SHA-256 ${check.sha256}${check.pinned ? '' : ' (not the pinned revision)'}.`,
          `Oort bench ${VERSION}; embed ${m.embedLabel}; rerank ${m.rerankLabel}; relevance gate ${a.noGate ? 'off' : 'on'}; links ${r.links}.`,
        ])}\n\n`,
      );
    }
  }
  log(`overall turn recall@10 ${cell(reports[0]?.turn.groups['overall']?.recallAt[10])}`);
  return 0;
}
