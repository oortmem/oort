// The tiny ONNX fixture models of @oortmem/local-models as catalog entries, for CLI tests that
// run local models end to end without downloading anything real.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODELS,
  type DecideModelSpec,
  type EmbedModelSpec,
  type ModelSpec,
  type RerankModelSpec,
} from '@oortmem/local-models';

const FIXTURES = fileURLToPath(new URL('../../local-models/test/fixtures/', import.meta.url));

function fixtureFiles(dir: string): ModelSpec['files'] {
  return (['model.onnx', 'tokenizer.json', 'tokenizer_config.json'] as const).map((name) => {
    const data = fs.readFileSync(path.join(FIXTURES, dir, name));
    return {
      name,
      path: `${dir}/${name}`,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  });
}

const common = {
  size: 'small' as const,
  source: { repo: 'oort/tiny', revision: 'test' },
  upstream: 'none',
  licence: 'Apache-2.0',
  maxTokens: 32,
};
export const TINY_EMBED: EmbedModelSpec = {
  ...common,
  id: 'tiny-embed',
  role: 'embed',
  label: 'tiny test embedder',
  files: fixtureFiles('tiny-embed'),
  nativeDimension: 8,
  pooling: 'mean',
  matryoshka: false,
  queryPrefix: '',
  documentPrefix: '',
};
export const TINY_RERANK: RerankModelSpec = {
  ...common,
  id: 'tiny-rerank',
  role: 'rerank',
  label: 'tiny test reranker',
  files: fixtureFiles('tiny-rerank'),
  // Puts the tiny model's on-topic pairs above the 0.35 relevance gate.
  calibration: { scale: 1, shift: 3 },
};

export const TINY_DECIDE: DecideModelSpec = {
  ...common,
  id: 'tiny-decide',
  role: 'decide',
  label: 'tiny test decoder',
  files: fixtureFiles('tiny-decide'),
  maxTokens: 256,
  kvCache: { layers: 1, heads: 1, headDim: 4 },
  template: 'chatml',
  calibration: {},
};

/** Serves fixture files by URL path; records every request. */
export function fixtureFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.href);
    const m = /\/resolve\/[^/]+\/(.+)$/.exec(url.pathname);
    const file = m === null ? undefined : path.join(FIXTURES, m[1]!);
    if (file === undefined || !fs.existsSync(file)) return new Response('nope', { status: 404 });
    return new Response(new Uint8Array(fs.readFileSync(file)), { status: 200 });
  }) as typeof fetch;
}

/** Adds the tiny models to the catalog; returns the undo. */
export function registerTinyModels(): () => void {
  const list = MODELS as ModelSpec[];
  list.push(TINY_EMBED, TINY_RERANK, TINY_DECIDE);
  return () => {
    for (const id of [TINY_EMBED.id, TINY_RERANK.id, TINY_DECIDE.id]) {
      const i = list.findIndex((m) => m.id === id);
      if (i >= 0) list.splice(i, 1);
    }
  };
}
