import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findModel, MODELS, type EmbedModelSpec, type RerankModelSpec } from './catalog.js';
import { localEmbedder } from './embed.js';
import { clipTokens, normalize, quantize } from './encode.js';
import { LocalModelError } from './errors.js';
import { modelDir, pullModel } from './files.js';
import { localReranker, rerankScore } from './rerank.js';
import { onnxRuntime, type Feed } from './runtime.js';
import {
  fakeRuntime,
  fixtureFetch,
  tinyEmbedSpec,
  tinyRerankSpec,
  tmpHome,
  writeReady,
} from '../test/support.js';

const cosine = (a: Int8Array, b: Int8Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
};

const homes: string[] = [];
const home = (): string => {
  const h = tmpHome();
  homes.push(h);
  return h;
};
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

/** Hidden states where token j of row i is [i, j, 1, 0, ...] in `hidden` dims. */
function hiddenStates(hidden: number) {
  return (feeds: Record<string, Feed>) => {
    const [n, L] = feeds['input_ids']!.dims as [number, number];
    const data = new Float32Array(n * L * hidden);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < L; j++) {
        const at = (i * L + j) * hidden;
        data[at] = i + 1;
        data[at + 1] = j + 1;
        data[at + 2] = 1;
      }
    }
    return { last_hidden_state: { data, dims: [n, L, hidden] } };
  };
}

describe('localEmbedder with ONNX Runtime and the tiny fixture model', () => {
  let h: string;
  beforeAll(async () => {
    h = tmpHome();
    await pullModel(h, tinyEmbedSpec(), { fetch: fixtureFetch() });
    await pullModel(h, tinyRerankSpec(), { fetch: fixtureFetch() });
  });
  afterAll(() => fs.rmSync(h, { recursive: true, force: true }));

  it('local.embed-runs-the-real-runtime', async () => {
    const embed = localEmbedder({
      home: h,
      model: 'tiny-embed',
      spec: tinyEmbedSpec(),
      dimension: 16,
    });
    expect(embed.dimension).toBe(16);
    const [q, same, other] = await embed.embed(
      ['what database backups', 'database backups are kept for 35 days', 'we use vitest'],
      'document',
    );
    expect(q).toBeInstanceOf(Int8Array);
    expect(q!.length).toBe(16);
    // Narrower than the store: zero-padded, so cosine is the model's own.
    expect(Array.from(q!.slice(8))).toEqual(Array.from({ length: 8 }, () => 0));
    expect(cosine(q!, same!)).toBeGreaterThan(cosine(q!, other!));
  });

  it('local.optimized-cache-loads-and-agrees', async () => {
    const runtime = onnxRuntime();
    const dir = modelDir(h, 'tiny-embed');
    await runtime.optimize!(dir);
    expect(fs.readdirSync(dir).some((f) => /^model\.ort-.+\.opt\.onnx$/.test(f))).toBe(true);
    const cached = localEmbedder({
      home: h,
      model: 'tiny-embed',
      spec: tinyEmbedSpec(),
      dimension: 8,
      runtime,
    });
    const [a] = await cached.embed(['oort setup demo word'], 'query');
    for (const f of fs.readdirSync(dir)) if (f.includes('.opt.')) fs.rmSync(path.join(dir, f));
    const plain = localEmbedder({
      home: h,
      model: 'tiny-embed',
      spec: tinyEmbedSpec(),
      dimension: 8,
    });
    const [b] = await plain.embed(['oort setup demo word'], 'query');
    expect(Array.from(a!)).toEqual(Array.from(b!));
  });

  it('local.rerank-runs-the-real-runtime', async () => {
    const rerank = localReranker({ home: h, model: 'tiny-rerank', spec: tinyRerankSpec() });
    const out = await rerank.rerank(
      'how long are database backups kept',
      [
        { id: 'vitest', text: 'we use vitest for tests' },
        { id: 'backups', text: 'database backups are retained for 35 days' },
        { id: 'port', text: 'search listens on port 2869 in development' },
      ],
      2,
    );
    expect(out.map((r) => r.id)).toEqual(['backups', expect.any(String)]);
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    for (const r of out) expect(r.score).toBeGreaterThan(0);
    for (const r of out) expect(r.score).toBeLessThan(1);
  });
});

describe('localEmbedder', () => {
  it('local.embed-refuses-a-model-that-was-not-pulled', () => {
    const h = home();
    expect(() => localEmbedder({ home: h, dimension: 512 })).toThrow(LocalModelError);
    expect(() => localEmbedder({ home: h, dimension: 512 })).toThrow(
      /bge-small-en-v1\.5 is not downloaded; run `oort models pull bge-small-en-v1\.5`/,
    );
    expect(() => localEmbedder({ home: h, model: 'nope', dimension: 512 })).toThrow(
      /embed\.model "nope" is not a local model/,
    );
    expect(() =>
      localEmbedder({ home: h, model: 'ms-marco-minilm-l6-v2', dimension: 512 }),
    ).toThrow(/is a rerank model/);
  });

  it('local.embed-loads-lazily-and-retries-a-failed-load', async () => {
    const h = home();
    const spec = tinyEmbedSpec();
    writeReady(h, spec);
    const rt = fakeRuntime(hiddenStates(8));
    let fail = true;
    const flaky = {
      ...rt,
      load: async (dir: string) => {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
        return rt.load(dir);
      },
    };
    const embed = localEmbedder({ home: h, model: spec.id, spec, dimension: 8, runtime: flaky });
    expect(rt.loads).toEqual([]);
    expect(await embed.embed([], 'query')).toEqual([]);
    expect(rt.loads).toEqual([]);
    await expect(embed.embed(['a'], 'query')).rejects.toThrow('boom');
    await embed.embed(['a'], 'query');
    await embed.embed(['b'], 'query');
    expect(rt.loads).toHaveLength(1);
  });

  it('local.embed-prefixes-batches-and-pools', async () => {
    const h = home();
    const spec = tinyEmbedSpec({ queryPrefix: 'Q: ', documentPrefix: 'D: ', pooling: 'cls' });
    writeReady(h, spec);
    const rt = fakeRuntime(hiddenStates(8));
    const embed = localEmbedder({
      home: h,
      model: spec.id,
      spec,
      dimension: 8,
      runtime: rt,
      batchSize: 2,
    });
    await embed.embed(['one'], 'query');
    const docs = await embed.embed(['a', 'b c', 'd e f', 'g', 'h'], 'document');
    expect(rt.texts).toEqual(['Q: one', 'D: a', 'D: b c', 'D: d e f', 'D: g', 'D: h']);
    expect(rt.runs).toHaveLength(1 + 3);
    expect(docs).toHaveLength(5);
    // cls: token 0 of each row, [i+1, 1, 1] normalised then quantised.
    expect(Array.from(docs[1]!.slice(0, 3))).toEqual(
      Array.from(quantize(normalize(Float32Array.from([2, 1, 1])))),
    );
  });

  it('local.embed-pools-mean-and-last-over-real-tokens-only', async () => {
    const h = home();
    for (const pooling of ['mean', 'last'] as const) {
      const spec = tinyEmbedSpec({ id: `tiny-${pooling}`, pooling });
      writeReady(h, spec);
      const rt = fakeRuntime(hiddenStates(8));
      const embed = localEmbedder({ home: h, model: spec.id, spec, dimension: 8, runtime: rt });
      // Row 0 has 3 tokens ([CLS] a [SEP]); row 1 pads it to 5.
      const [short] = await embed.embed(['a', 'b c d'], 'document');
      const expected = pooling === 'mean' ? [1, 2, 1] : [1, 3, 1];
      expect(Array.from(short!.slice(0, 3))).toEqual(
        Array.from(quantize(normalize(Float32Array.from(expected)))),
      );
    }
  });

  it('local.embed-truncates-matryoshka-and-refuses-wider-plain-models', async () => {
    const h = home();
    const mrl = tinyEmbedSpec({ id: 'tiny-mrl', matryoshka: true, nativeDimension: 8 });
    writeReady(h, mrl);
    const rt = fakeRuntime(hiddenStates(8));
    const embed = localEmbedder({ home: h, model: mrl.id, spec: mrl, dimension: 4, runtime: rt });
    const [v] = await embed.embed(['x'], 'query');
    expect(v!.length).toBe(4);
    const plain = tinyEmbedSpec({ id: 'tiny-plain', nativeDimension: 8 });
    writeReady(h, plain);
    expect(() =>
      localEmbedder({ home: h, model: plain.id, spec: plain, dimension: 4, runtime: rt }),
    ).toThrow(/cannot be truncated/);
  });

  it('local.embed-feeds-a-decoder-export-empty-past-key-values', async () => {
    const h = home();
    const spec: EmbedModelSpec = tinyEmbedSpec({
      id: 'tiny-decoder',
      pooling: 'last',
      kvCache: { layers: 2, heads: 2, headDim: 4 },
    });
    writeReady(h, spec);
    const rt = fakeRuntime(hiddenStates(8), ['input_ids', 'attention_mask', 'position_ids']);
    const embed = localEmbedder({ home: h, model: spec.id, spec, dimension: 8, runtime: rt });
    await embed.embed(['a b'], 'query');
    const feeds = rt.runs[0]!.feeds;
    expect(Object.keys(feeds).sort()).toEqual(
      [
        'attention_mask',
        'input_ids',
        'past_key_values.0.key',
        'past_key_values.0.value',
        'past_key_values.1.key',
        'past_key_values.1.value',
        'position_ids',
      ].sort(),
    );
    expect(feeds['past_key_values.0.key']!.dims).toEqual([1, 2, 0, 4]);
    expect(Array.from(feeds['position_ids']!.data as BigInt64Array)).toEqual([0n, 1n, 2n, 3n]);
  });

  it('local.embed-catalog-specs-construct-when-pulled', () => {
    const h = home();
    const spec = findModel('qwen3-embedding-0.6b')!;
    writeReady(h, spec);
    const embed = localEmbedder({
      home: h,
      model: spec.id,
      dimension: 512,
      runtime: fakeRuntime(hiddenStates(1024)),
    });
    expect(embed.model).toBe('qwen3-embedding-0.6b');
    expect(embed.dimension).toBe(512);
  });
});

describe('localReranker', () => {
  const logits = (values: number[]) => (feeds: Record<string, Feed>) => {
    const n = feeds['input_ids']!.dims[0]!;
    return { logits: { data: Float32Array.from(values.splice(0, n)), dims: [n, 1] } };
  };

  it('local.rerank-calibrates-sorts-and-cuts-to-topk', async () => {
    const h = home();
    const calibration = (findModel('ms-marco-minilm-l6-v2') as RerankModelSpec).calibration;
    const spec = tinyRerankSpec({ calibration });
    writeReady(h, spec);
    const rt = fakeRuntime(logits([-10, 8, 0.21]));
    const rerank = localReranker({ home: h, model: spec.id, spec, runtime: rt });
    const out = await rerank.rerank(
      'q',
      [
        { id: 'a', text: 'x' },
        { id: 'b', text: 'y' },
        { id: 'c', text: 'z' },
      ],
      2,
    );
    expect(out.map((r) => r.id)).toEqual(['b', 'c']);
    expect(out[0]!.score).toBeCloseTo(rerankScore(8, calibration), 6);
    // MiniLM's calibration (CON-96) puts the default 0.35 gate at logit 0.21.
    expect(out[1]!.score).toBeCloseTo(0.35, 2);
    expect(rt.texts).toEqual(['q || x', 'q || y', 'q || z']);
  });

  it('local.rerank-equal-scores-keep-the-fused-order', async () => {
    // Recall hands the reranker its candidates in fused order (RRF with the activation boost,
    // which favours what was used recently). Pairs the model scores alike, such as two copies
    // of one note, keep that order, as they do with Voyage.
    const h = home();
    const spec = tinyRerankSpec({ calibration: { scale: 1.5, shift: -0.93 } });
    writeReady(h, spec);
    const rt = fakeRuntime(logits([2, 9, 2, 9]));
    const rerank = localReranker({ home: h, model: spec.id, spec, runtime: rt });
    const out = await rerank.rerank(
      'q',
      ['newer', 'best-1', 'older', 'best-2'].map((id) => ({ id, text: id })),
      4,
    );
    expect(out.map((r) => r.id)).toEqual(['best-1', 'best-2', 'newer', 'older']);
  });

  it('local.rerank-batches-and-skips-loading-for-no-docs', async () => {
    const h = home();
    const spec = tinyRerankSpec();
    writeReady(h, spec);
    const rt = fakeRuntime(logits([1, 2, 3, 4, 5]));
    const rerank = localReranker({ home: h, model: spec.id, spec, runtime: rt, batchSize: 2 });
    expect(await rerank.rerank('q', [], 5)).toEqual([]);
    expect(rt.loads).toEqual([]);
    const out = await rerank.rerank(
      'q',
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, text: id })),
      10,
    );
    expect(rt.runs).toHaveLength(3);
    expect(out.map((r) => r.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('local.clip-keeps-the-final-special-token', () => {
    const e = { ids: [101, 1, 2, 3, 4, 102], token_type_ids: [0, 0, 0, 1, 1, 1] };
    expect(clipTokens(e, 4)).toEqual({ ids: [101, 1, 2, 102], token_type_ids: [0, 0, 0, 1] });
    expect(clipTokens(e, 10)).toBe(e);
  });
});

describe('rerankScore', () => {
  const rerankers = MODELS.filter((m): m is RerankModelSpec => m.role === 'rerank');
  const grid = Array.from({ length: 801 }, (_, i) => -40 + i * 0.1);

  it('local.rerank-calibration-is-increasing-and-within-0-1', () => {
    for (const m of rerankers) {
      expect(m.calibration.scale, m.id).toBeGreaterThan(0);
      const scores = grid.map((x) => rerankScore(x, m.calibration));
      for (const s of scores) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
      // Strictly increasing wherever float64 can tell the scores apart (it saturates past ~36).
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]!, `${m.id} at ${grid[i]}`).toBeGreaterThanOrEqual(scores[i - 1]!);
      }
      const mid = grid.filter((x) => Math.abs(m.calibration.scale * x + m.calibration.shift) < 30);
      for (let i = 1; i < mid.length; i++) {
        expect(rerankScore(mid[i]!, m.calibration)).toBeGreaterThan(
          rerankScore(mid[i - 1]!, m.calibration),
        );
      }
    }
  });

  it('local.minilm-calibration-lands-on-voyage-margin', () => {
    // The eval margin it was fitted on (CON-96): MiniLM's lowest answerable logit 1.414 maps to
    // Voyage's lowest answerable score 0.767, and its highest kept abstention logit 0.062 to
    // Voyage's highest abstention score 0.303, so recall.minRerankScore (0.35) falls between.
    const c = (findModel('ms-marco-minilm-l6-v2') as RerankModelSpec).calibration;
    expect(rerankScore(1.414, c)).toBeCloseTo(0.767, 2);
    expect(rerankScore(0.062, c)).toBeCloseTo(0.303, 2);
    expect(rerankScore(0.062, c)).toBeLessThan(0.35);
    expect(rerankScore(1.414, c)).toBeGreaterThan(0.35);
    // Unrelated pairs (MS MARCO logits near -10) score about 0, clearly relevant ones (8) about 1,
    // and nothing MiniLM can emit saturates to exactly 1, so scores stay distinct.
    expect(rerankScore(-10, c)).toBeLessThan(0.001);
    expect(rerankScore(8, c)).toBeGreaterThan(0.99);
    expect(rerankScore(12, c)).toBeLessThan(1);
  });
});
