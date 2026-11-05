import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DECIDE_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  MODELS,
  downloadBytes,
  findModel,
  type ModelSpec,
} from './catalog.js';
import {
  ChecksumError,
  MANIFEST,
  decideModelId,
  fileUrl,
  modelDir,
  modelState,
  pullModel,
  removeModel,
  verifyModel,
} from './files.js';
import {
  fixtureFetch,
  tinyDecideSpec,
  tinyEmbedSpec,
  tmpHome,
  writeReady,
} from '../test/support.js';

const homes: string[] = [];
const home = (): string => {
  const h = tmpHome();
  homes.push(h);
  return h;
};
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

describe('catalog', () => {
  it('local.catalog-pins-every-file', () => {
    const ids = new Set<string>();
    for (const m of MODELS) {
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      expect(m.source.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.files.map((f) => f.name).sort()).toEqual([
        'model.onnx',
        'tokenizer.json',
        'tokenizer_config.json',
      ]);
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(0);
      }
      expect(['MIT', 'Apache-2.0']).toContain(m.licence);
    }
  });

  it('local.defaults-are-small-and-fit-512', () => {
    const embed = findModel(DEFAULT_EMBED_MODEL);
    const rerank = findModel(DEFAULT_RERANK_MODEL);
    expect(embed?.role).toBe('embed');
    expect(rerank?.role).toBe('rerank');
    expect(embed?.size).toBe('small');
    expect(rerank?.size).toBe('small');
    expect(downloadBytes(embed!) + downloadBytes(rerank!)).toBeLessThan(60_000_000);
    for (const m of MODELS) {
      if (m.role === 'embed') expect(m.nativeDimension <= 512 || m.matryoshka).toBe(true);
    }
  });

  it('local.decide-default-is-a-calibrated-decoder', () => {
    const d = findModel(DEFAULT_DECIDE_MODEL);
    expect(d?.role).toBe('decide');
    if (d?.role !== 'decide') return;
    expect(d.kvCache.layers).toBeGreaterThan(0);
    // Every yes-or-no question the decider asks has a fitted bias.
    expect(Object.keys(d.calibration).sort()).toEqual([
      'conflict',
      'mistake',
      'newinfo',
      'novel',
      'related',
      'samefact',
      'should_store',
      'volatile',
    ]);
  });

  it('local.decide-model-id-prefers-the-default-then-any-downloaded', () => {
    const h = home();
    expect(decideModelId(h)).toBe(DEFAULT_DECIDE_MODEL);
    const list = MODELS as ModelSpec[];
    list.push(tinyDecideSpec());
    try {
      writeReady(h, tinyDecideSpec());
      expect(decideModelId(h)).toBe('tiny-decide');
    } finally {
      list.splice(
        list.findIndex((m) => m.id === 'tiny-decide'),
        1,
      );
    }
  });

  it('local.urls-are-pinned-to-the-revision', () => {
    const m = findModel(DEFAULT_EMBED_MODEL)!;
    expect(fileUrl(m, m.files[0]!)).toBe(
      `https://huggingface.co/${m.source.repo}/resolve/${m.source.revision}/onnx/model_int8.onnx`,
    );
    expect(fileUrl(m, m.files[0]!, 'https://mirror.example/hf/')).toMatch(
      /^https:\/\/mirror\.example\/hf\/Xenova\//,
    );
  });
});

describe('pullModel', () => {
  it('local.pull-verifies-and-writes-manifest', async () => {
    const h = home();
    const spec = tinyEmbedSpec();
    expect(modelState(h, spec)).toBe('missing');
    const progress: string[] = [];
    const bytes = await pullModel(h, spec, {
      fetch: fixtureFetch(),
      onProgress: (p) => progress.push(p.file),
    });
    expect(bytes).toBe(downloadBytes(spec));
    expect(progress).toContain('model.onnx');
    expect(modelState(h, spec)).toBe('ready');
    expect((await verifyModel(h, spec)).ok).toBe(true);
    const dir = modelDir(h, spec.id);
    expect(fs.readdirSync(dir).sort()).toEqual(
      [MANIFEST, 'model.onnx', 'tokenizer.json', 'tokenizer_config.json'].sort(),
    );
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, 'model.onnx')).mode & 0o777).toBe(0o600);
    }
  });

  it('local.pull-refuses-a-checksum-mismatch-and-keeps-nothing', async () => {
    const h = home();
    const spec = tinyEmbedSpec();
    await expect(
      pullModel(h, spec, { fetch: fixtureFetch({ tamper: 'model.onnx' }) }),
    ).rejects.toThrow(ChecksumError);
    const dir = modelDir(h, spec.id);
    expect(fs.existsSync(path.join(dir, 'model.onnx'))).toBe(false);
    expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false);
    expect(modelState(h, spec)).toBe('incomplete');
  });

  it('local.pull-refuses-a-wrong-size', async () => {
    const h = home();
    const spec = tinyEmbedSpec();
    const short = { ...spec, files: spec.files.map((f) => ({ ...f, bytes: f.bytes + 1 })) };
    await expect(pullModel(h, short, { fetch: fixtureFetch() })).rejects.toThrow(/bytes, expected/);
    const long = { ...spec, files: spec.files.map((f) => ({ ...f, bytes: f.bytes - 1 })) };
    await expect(pullModel(h, long, { fetch: fixtureFetch() })).rejects.toThrow(/more than/);
  });

  it('local.pull-reports-http-errors', async () => {
    const h = home();
    const spec = {
      ...tinyEmbedSpec(),
      files: [{ ...tinyEmbedSpec().files[0]!, path: 'nope/model.onnx' }],
    };
    await expect(pullModel(h, spec, { fetch: fixtureFetch() })).rejects.toThrow(/HTTP 404/);
  });

  it('local.pull-resumes-keeping-verified-files', async () => {
    const h = home();
    const spec = tinyEmbedSpec();
    await expect(
      pullModel(h, spec, { fetch: fixtureFetch({ tamper: 'tokenizer_config.json' }) }),
    ).rejects.toThrow(ChecksumError);
    const calls: string[] = [];
    await pullModel(h, spec, { fetch: fixtureFetch({ calls }) });
    expect(calls).toEqual(['/oort/tiny/resolve/test/tiny-embed/tokenizer_config.json']);
    expect(modelState(h, spec)).toBe('ready');
  });

  it('local.state-detects-truncation-and-outdated-pins', async () => {
    const h = home();
    const spec = tinyEmbedSpec();
    await pullModel(h, spec, { fetch: fixtureFetch() });
    const next = { ...spec, source: { ...spec.source, revision: 'other' } };
    expect(modelState(h, next)).toBe('outdated');
    fs.truncateSync(path.join(modelDir(h, spec.id), 'model.onnx'), 10);
    expect(modelState(h, spec)).toBe('incomplete');
  });

  it('local.verify-detects-a-changed-file', async () => {
    const h = home();
    const spec = tinyEmbedSpec();
    await pullModel(h, spec, { fetch: fixtureFetch() });
    const file = path.join(modelDir(h, spec.id), 'tokenizer.json');
    const data = fs.readFileSync(file);
    data[10] = data[10]! ^ 1;
    fs.writeFileSync(file, data);
    expect(modelState(h, spec)).toBe('ready'); // same size: only a re-hash notices
    expect(await verifyModel(h, spec)).toEqual({ ok: false, bad: ['tokenizer.json'] });
  });

  it('local.remove-deletes-only-a-model-directory', async () => {
    const h = home();
    const spec = tinyEmbedSpec();
    await pullModel(h, spec, { fetch: fixtureFetch() });
    expect(removeModel(h, spec.id)).toBe(true);
    expect(removeModel(h, spec.id)).toBe(false);
    expect(fs.existsSync(path.join(h, 'models'))).toBe(true);
    expect(() => removeModel(h, '..')).toThrow(/not a model id/);
    expect(() => removeModel(h, '../x')).toThrow(/not a model id/);
  });
});
