// Shared by this package's tests: the tiny fixture models as catalog specs,
// a fetch that serves them, and a recording fake runtime. Not exported from the package root.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmbedModelSpec, ModelFile, ModelSpec, RerankModelSpec } from '../src/catalog.js';
import type { Feed, LoadedModel, Output, Runtime } from '../src/runtime.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function files(dir: string): ModelFile[] {
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

/** 8-dim mean-pooled "topic" embedder (see scripts/make-test-models.py). */
export function tinyEmbedSpec(over: Partial<EmbedModelSpec> = {}): EmbedModelSpec {
  return {
    id: 'tiny-embed',
    role: 'embed',
    label: 'tiny test embedder',
    size: 'small',
    source: { repo: 'oort/tiny', revision: 'test' },
    upstream: 'none',
    licence: 'Apache-2.0',
    files: files('tiny-embed'),
    maxTokens: 32,
    nativeDimension: 8,
    pooling: 'mean',
    matryoshka: false,
    queryPrefix: '',
    documentPrefix: '',
    ...over,
  };
}

export function tinyRerankSpec(over: Partial<RerankModelSpec> = {}): RerankModelSpec {
  return {
    id: 'tiny-rerank',
    role: 'rerank',
    label: 'tiny test reranker',
    size: 'small',
    source: { repo: 'oort/tiny', revision: 'test' },
    upstream: 'none',
    licence: 'Apache-2.0',
    files: files('tiny-rerank'),
    maxTokens: 32,
    calibration: { scale: 1, shift: 0 },
    ...over,
  };
}

/** A fetch serving fixture files by URL path (`/<repo>/resolve/<rev>/<dir>/<name>`). */
export function fixtureFetch(opts: { tamper?: string; calls?: string[] } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    opts.calls?.push(url.pathname);
    const m = /\/resolve\/[^/]+\/(.+)$/.exec(url.pathname);
    const file = m === null ? undefined : path.join(FIXTURES, m[1]!);
    if (file === undefined || !fs.existsSync(file))
      return new Response('not found', { status: 404 });
    const data = new Uint8Array(fs.readFileSync(file));
    if (opts.tamper !== undefined && file.endsWith(opts.tamper)) data[data.length - 1]! ^= 0xff;
    return new Response(data, { status: 200 });
  }) as typeof fetch;
}

export function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oort-local-models-'));
}

export interface FakeRun {
  feeds: Record<string, Feed>;
  outputs: readonly string[];
}

/**
 * A runtime that never touches ONNX: token ids are word lengths, and the session answers with
 * `respond`. Records loads and runs.
 */
export function fakeRuntime(
  respond: (feeds: Record<string, Feed>) => Record<string, Output>,
  inputNames: readonly string[] = ['input_ids', 'attention_mask', 'token_type_ids'],
): Runtime & { loads: string[]; runs: FakeRun[]; texts: string[] } {
  const loads: string[] = [];
  const runs: FakeRun[] = [];
  const texts: string[] = [];
  return {
    loads,
    runs,
    texts,
    async load(dir): Promise<LoadedModel> {
      loads.push(dir);
      return {
        tokenizer: {
          encode(text, pair) {
            texts.push(pair === undefined ? text : `${text} || ${pair}`);
            const words = (pair === undefined ? text : `${text} ${pair}`)
              .split(/\s+/)
              .filter(Boolean);
            const ids = [101, ...words.map((w) => w.length), 102];
            return { ids, token_type_ids: ids.map(() => 0) };
          },
        },
        session: {
          inputNames,
          async run(feeds, outputs) {
            runs.push({ feeds, outputs });
            return respond(feeds);
          },
        },
      };
    },
  };
}

export function writeReady(home: string, spec: ModelSpec): void {
  const dir = path.join(home, 'models', spec.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of spec.files) fs.writeFileSync(path.join(dir, f.name), Buffer.alloc(f.bytes));
  fs.writeFileSync(
    path.join(dir, 'oort-model.json'),
    JSON.stringify({
      id: spec.id,
      revision: spec.source.revision,
      files: spec.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
      pulledAt: new Date(0).toISOString(),
    }),
  );
}
