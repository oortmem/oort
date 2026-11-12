/**
 * The public datasets the bench scores at retrieval level (CON-147, design section 11). They are
 * never bundled and never downloaded by tests: `pnpm eval --set <name> --fetch` downloads a pinned
 * revision into the gitignored cache and checks its SHA-256 against the value recorded here, and
 * every run checks it again and prints it.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DatasetSource {
  name: string;
  /** The file inside the cache directory. */
  file: string;
  /** Pinned URL of the exact revision. */
  url: string;
  revision: string;
  sha256: string;
  bytes: number;
  licence: string;
  /** Where the licence is stated. */
  licenceUrl: string;
  citation: string;
}

export const DATASETS = {
  locomo: {
    name: 'LoCoMo (locomo10.json)',
    file: 'locomo/locomo10.json',
    url: 'https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json',
    revision: 'snap-research/locomo@3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376',
    sha256: '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4',
    bytes: 2_805_274,
    licence: 'CC BY-NC 4.0',
    licenceUrl:
      'https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt',
    citation:
      'Maharana et al., "Evaluating Very Long-Term Conversational Memory of LLM Agents", ACL 2024 (arXiv:2402.17753)',
  },
  longmemeval: {
    name: 'LongMemEval_S (longmemeval_s_cleaned.json)',
    file: 'longmemeval/longmemeval_s_cleaned.json',
    url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json',
    revision: 'xiaowu0162/longmemeval-cleaned@98d7416c24c778c2fee6e6f3006e7a073259d48f',
    sha256: 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442',
    bytes: 277_383_467,
    licence: 'MIT',
    licenceUrl: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned',
    citation:
      'Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", ICLR 2025 (arXiv:2410.10813)',
  },
} as const satisfies Record<string, DatasetSource>;

export type DatasetName = keyof typeof DATASETS;

/** `packages/bench/.cache/` (gitignored), shared with the link-shaped latency stores. */
export const CACHE_DIR = fileURLToPath(new URL('../.cache/', import.meta.url));

export const datasetPath = (name: DatasetName, cacheDir = CACHE_DIR): string =>
  path.join(cacheDir, 'datasets', DATASETS[name].file);

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The file's SHA-256 and whether it is the recorded revision. */
export function checkDataset(name: DatasetName, file: string): { sha256: string; pinned: boolean } {
  const sha256 = sha256File(file);
  return { sha256, pinned: sha256 === DATASETS[name].sha256 };
}

/**
 * Downloads the pinned revision into the cache, unless a file with the recorded hash is already
 * there. A download whose hash differs is deleted and rejected.
 */
export async function fetchDataset(
  name: DatasetName,
  opts: { cacheDir?: string; fetch?: typeof fetch; log?: (m: string) => void } = {},
): Promise<string> {
  const src: DatasetSource = DATASETS[name];
  const dest = datasetPath(name, opts.cacheDir);
  if (fs.existsSync(dest) && sha256File(dest) === src.sha256) return dest;
  opts.log?.(
    `downloading ${src.name} (${(src.bytes / 1e6).toFixed(1)} MB, ${src.licence}) from ${src.url}`,
  );
  const res = await (opts.fetch ?? fetch)(src.url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${src.url}`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== src.sha256) {
    throw new Error(`${src.name}: SHA-256 ${got} is not the recorded ${src.sha256}; not saved`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.tmp`, body);
  fs.renameSync(`${dest}.tmp`, dest);
  return dest;
}
