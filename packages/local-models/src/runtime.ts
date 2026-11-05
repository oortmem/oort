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

export interface Runtime {
  /** Loads the model in `dir` (`model.onnx` plus tokenizer files), preferring the optimised cache. */
  load(dir: string, opts?: { threads?: number }): Promise<LoadedModel>;
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
  return {
    async load(dir, opts = {}) {
      const o = await ort();
      const tokenizer = loadTokenizer(dir);
      const threads = { intraOpNumThreads: opts.threads ?? defaultThreads(), interOpNumThreads: 1 };
      const cached = cacheFile(dir, o);
      let session: import('onnxruntime-node').InferenceSession | undefined;
      if (fs.existsSync(cached)) {
        try {
          session = await o.InferenceSession.create(cached, {
            ...quiet,
            ...threads,
            graphOptimizationLevel: 'disabled',
          });
        } catch {
          session = undefined; // a damaged cache: the original model still loads
        }
      }
      session ??= await o.InferenceSession.create(path.join(dir, 'model.onnx'), {
        ...quiet,
        ...threads,
        graphOptimizationLevel: 'all',
      });
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
