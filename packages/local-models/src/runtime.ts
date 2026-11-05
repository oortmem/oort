import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The seam between Oort's pooling and scoring code and the inference runtime. The default is
 * ONNX Runtime (onnxruntime-node) with Hugging Face's pure-JS tokenizers, both imported on
 * first use only; tests inject a fake.
 */

export interface Feed {
  type: 'int64' | 'float32';
  data: BigInt64Array | Float32Array;
  dims: number[];
}

export interface Output {
  data: Float32Array;
  dims: readonly number[];
}

export interface Session {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, Feed>, outputs: readonly string[]): Promise<Record<string, Output>>;
}

export interface Encoding {
  ids: number[];
  token_type_ids?: number[];
}

export interface TextTokenizer {
  /** Special tokens included; `pair` is the second segment of a cross-encoder input. */
  encode(text: string, pair?: string): Encoding;
}

export interface LoadedModel {
  session: Session;
  tokenizer: TextTokenizer;
}

/** The shape of a decoder's key/value cache: `past_key_values.<layer>.key|value`. */
export interface KvShape {
  layers: number;
  heads: number;
  headDim: number;
}

/** A decoder's key/value cache after `length` tokens. Opaque outside the runtime. */
export interface KvCache {
  readonly length: number;
}

export interface DecoderTokenizer {
  /** Token ids of `text`; special tokens written in it (`<|im_start|>`) count as such, none is added. */
  encode(text: string): number[];
}

/** A causal language model, run one prompt at a time (batch 1). */
export interface LoadedDecoder {
  tokenizer: DecoderTokenizer;
  /**
   * Runs `ids` after `past` (from scratch without it) and returns the logits at the last position
   * and the cache extended by `ids`. `past` is left as it was, so one prefix serves many suffixes.
   */
  forward(
    ids: readonly number[],
    past?: KvCache,
  ): Promise<{ logits: Float32Array; cache: KvCache }>;
}

export interface Runtime {
  /** Loads the model in `dir` (`model.onnx` plus tokenizer files), preferring the optimised cache. */
  load(dir: string, opts?: { threads?: number }): Promise<LoadedModel>;
  /** Loads the decoder in `dir`; a runtime without it cannot run a decision model. */
  loadDecoder?(dir: string, kv: KvShape, opts?: { threads?: number }): Promise<LoadedDecoder>;
  /**
   * Writes the optimised cache beside `model.onnx` (graph optimisations already applied, so a
   * later load skips them: about 5x faster for the default models). Run once after a pull.
   */
  optimize?(dir: string): Promise<void>;
}

/** Intra-op threads: up to 4. Small batches gain little beyond that, and hooks share the CPU. */
export function defaultThreads(): number {
  return Math.max(1, Math.min(4, os.availableParallelism()));
}

type Ort = typeof import('onnxruntime-node');

/** The cache file name carries the runtime version: a runtime upgrade never loads a stale one. */
function cacheFile(dir: string, ort: Ort): string {
  const v = ort.env.versions.node ?? ort.env.versions.common;
  return path.join(dir, `model.ort-${v}.opt.onnx`);
}

async function loadTokenizer(dir: string): Promise<TextTokenizer> {
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const read = (name: string): object =>
    JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as object;
  const t = new Tokenizer(read('tokenizer.json'), read('tokenizer_config.json'));
  return {
    encode(text, pair) {
      const e = t.encode(text, { text_pair: pair ?? null, return_token_type_ids: true });
      return { ids: e.ids, token_type_ids: e.token_type_ids };
    },
  };
}

async function loadDecoderTokenizer(dir: string): Promise<DecoderTokenizer> {
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const read = (name: string): object =>
    JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as object;
  const t = new Tokenizer(read('tokenizer.json'), read('tokenizer_config.json'));
  return { encode: (text) => t.encode(text, { add_special_tokens: false }).ids };
}

/** Holds the present tensors of one run, fed back as the next run's past. */
interface OrtKv extends KvCache {
  tensors: Record<string, import('onnxruntime-node').Tensor>;
}

function decoder(
  ort: Ort,
  s: import('onnxruntime-node').InferenceSession,
  kv: KvShape,
  tokenizer: DecoderTokenizer,
): LoadedDecoder {
  const wantsPositions = s.inputNames.includes('position_ids');
  const empty = new ort.Tensor('float32', new Float32Array(0), [1, kv.heads, 0, kv.headDim]);
  return {
    tokenizer,
    async forward(ids, past) {
      const n = ids.length;
      if (n === 0) throw new Error('local model: forward needs at least one token');
      const p = past?.length ?? 0;
      const prior = (past as OrtKv | undefined)?.tensors;
      const feeds: Record<string, import('onnxruntime-node').Tensor> = {
        input_ids: new ort.Tensor(
          'int64',
          BigInt64Array.from(ids, (i) => BigInt(i)),
          [1, n],
        ),
        attention_mask: new ort.Tensor('int64', new BigInt64Array(p + n).fill(1n), [1, p + n]),
      };
      if (wantsPositions) {
        const pos = BigInt64Array.from({ length: n }, (_, i) => BigInt(p + i));
        feeds['position_ids'] = new ort.Tensor('int64', pos, [1, n]);
      }
      for (let l = 0; l < kv.layers; l++) {
        for (const k of ['key', 'value']) {
          feeds[`past_key_values.${l}.${k}`] = prior?.[`${l}.${k}`] ?? empty;
        }
      }
      const out = await s.run(feeds);
      const logits = out['logits'];
      if (
        logits === undefined ||
        !(logits.data instanceof Float32Array) ||
        logits.dims.length !== 3
      ) {
        throw new Error('local model: logits are missing or not float32 [1, n, vocab]');
      }
      const vocab = logits.dims[2]!;
      const tensors: OrtKv['tensors'] = {};
      for (let l = 0; l < kv.layers; l++) {
        for (const k of ['key', 'value']) {
          const t = out[`present.${l}.${k}`];
          if (t === undefined) throw new Error(`local model: output present.${l}.${k} is missing`);
          tensors[`${l}.${k}`] = t;
        }
      }
      const cache: OrtKv = { length: p + n, tensors };
      return { logits: logits.data.slice((n - 1) * vocab, n * vocab), cache };
    },
  };
}

function wrap(ort: Ort, s: import('onnxruntime-node').InferenceSession): Session {
  return {
    inputNames: s.inputNames,
    async run(feeds, outputs) {
      const tensors: Record<string, import('onnxruntime-node').Tensor> = {};
      for (const [name, f] of Object.entries(feeds)) {
        tensors[name] = new ort.Tensor(f.type, f.data, f.dims);
      }
      const out = await s.run(tensors, outputs as string[]);
      const result: Record<string, Output> = {};
      for (const name of outputs) {
        const t = out[name];
        if (t === undefined || !(t.data instanceof Float32Array)) {
          throw new Error(`local model: output ${name} is missing or not float32`);
        }
        result[name] = { data: t.data, dims: t.dims };
      }
      return result;
    },
  };
}

export function onnxRuntime(): Runtime {
  let ortP: Promise<Ort> | undefined;
  const ort = (): Promise<Ort> => (ortP ??= import('onnxruntime-node'));
  // Warnings (unused initialisers and the like) would land on a hook's stderr.
  const quiet = { logSeverityLevel: 3 as const };
  const create = async (
    o: Ort,
    dir: string,
    threads: { intraOpNumThreads: number; interOpNumThreads: number },
  ): Promise<import('onnxruntime-node').InferenceSession> => {
    const cached = cacheFile(dir, o);
    if (fs.existsSync(cached)) {
      try {
        return await o.InferenceSession.create(cached, {
          ...quiet,
          ...threads,
          graphOptimizationLevel: 'disabled',
        });
      } catch {
        // a damaged cache: the original model still loads
      }
    }
    return o.InferenceSession.create(path.join(dir, 'model.onnx'), {
      ...quiet,
      ...threads,
      graphOptimizationLevel: 'all',
    });
  };
  return {
    async loadDecoder(dir, kv, opts = {}) {
      const o = await ort();
      const tokenizer = loadDecoderTokenizer(dir);
      const threads = { intraOpNumThreads: opts.threads ?? defaultThreads(), interOpNumThreads: 1 };
      return decoder(o, await create(o, dir, threads), kv, await tokenizer);
    },
    async load(dir, opts = {}) {
      const o = await ort();
      const tokenizer = loadTokenizer(dir);
      const threads = { intraOpNumThreads: opts.threads ?? defaultThreads(), interOpNumThreads: 1 };
      const session = await create(o, dir, threads);
      return { session: wrap(o, session), tokenizer: await tokenizer };
    },
    async optimize(dir) {
      const o = await ort();
      const dest = cacheFile(dir, o);
      const tmp = `${dest}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
      try {
        // `extended`, not `all`: the `all` level adds CPU-specific layout transforms.
        const s = await o.InferenceSession.create(path.join(dir, 'model.onnx'), {
          ...quiet,
          graphOptimizationLevel: 'extended',
          optimizedModelFilePath: tmp,
        });
        await s.release();
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, dest);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
  };
}

/**
 * Loads `dir` on the first call and shares the result; a failed load is retried on the next
 * call rather than remembered.
 */
export function lazyLoad(
  runtime: Runtime,
  dir: string,
  threads: number | undefined,
): () => Promise<LoadedModel> {
  let loaded: Promise<LoadedModel> | undefined;
  return () => {
    if (loaded === undefined) {
      const p = runtime.load(dir, threads === undefined ? {} : { threads });
      p.catch(() => {
        if (loaded === p) loaded = undefined;
      });
      loaded = p;
    }
    return loaded;
  };
}
