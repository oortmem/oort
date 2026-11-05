import * as fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pullModel, modelDir } from './files.js';
import { onnxRuntime } from './runtime.js';
import { fixtureFetch, tinyDecideSpec, tmpHome } from '../test/support.js';

describe('decoder runtime with ONNX Runtime and the tiny fixture decoder', () => {
  let h: string;
  beforeAll(async () => {
    h = tmpHome();
    await pullModel(h, tinyDecideSpec(), { fetch: fixtureFetch() });
  });
  afterAll(() => fs.rmSync(h, { recursive: true, force: true }));

  const load = () =>
    onnxRuntime().loadDecoder!(modelDir(h, 'tiny-decide'), tinyDecideSpec().kvCache, {
      threads: 1,
    });

  it('local.decoder-cache-equals-full-prompt', async () => {
    const m = await load();
    const prefix = '<|im_start|>system hello<|im_end|>\n<|im_start|>user ';
    const suffix = 'it moved now A B';
    const whole = await m.forward(m.tokenizer.encode(prefix + suffix));
    const first = await m.forward(m.tokenizer.encode(prefix));
    const second = await m.forward(m.tokenizer.encode(suffix), first.cache);
    expect(second.cache.length).toBe(whole.cache.length);
    expect(Array.from(second.logits)).toEqual(Array.from(whole.logits));
    // The prefix cache is not consumed: a second suffix on it sees the same past.
    const again = await m.forward(m.tokenizer.encode(suffix), first.cache);
    expect(Array.from(again.logits)).toEqual(Array.from(second.logits));
  });

  it('local.decoder-logits-follow-the-words', async () => {
    const m = await load();
    const d = m.tokenizer.encode('D')[0]!;
    const e = m.tokenizer.encode('E')[0]!;
    const changed = (await m.forward(m.tokenizer.encode('it moved now'))).logits;
    const wrong = (await m.forward(m.tokenizer.encode('a mistake never'))).logits;
    expect(changed[d]!).toBeGreaterThan(changed[e]!);
    expect(wrong[e]!).toBeGreaterThan(wrong[d]!);
    // Only the last position's logits come back: one per vocabulary entry.
    expect(changed.length).toBe(30);
  });

  it('local.decoder-special-tokens-are-single-ids', async () => {
    const m = await load();
    expect(m.tokenizer.encode('<|im_start|>')).toHaveLength(1);
    expect(m.tokenizer.encode('A')).toHaveLength(1);
  });
});
