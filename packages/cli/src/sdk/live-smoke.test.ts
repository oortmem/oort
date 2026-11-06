import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOort } from './create.js';

/**
 * The gated live smoke test (CON-108 §10.3): run before the release tag, never on pull requests.
 * Skipped unless `OORT_LIVE_KEY` holds a test account's Oort key. It recalls, observes (with a
 * unique turnRef), pins, unpins and forgets against Oort Cloud (`OORT_CLOUD_URL`, default
 * api.oortcloud.dev), and cleans up what it wrote.
 */
const KEY = process.env['OORT_LIVE_KEY'];

describe.skipIf(KEY === undefined || KEY === '')('live smoke test against Oort Cloud', () => {
  it('recall, observe, pin, unpin and forget', async () => {
    const oort = await createOort({
      mode: 'cloud',
      keys: { oort: KEY! },
      keySources: ['explicit'],
      project: 'oort-sdk-live-smoke',
      env: {
        ...(process.env['OORT_CLOUD_URL'] !== undefined && {
          OORT_CLOUD_URL: process.env['OORT_CLOUD_URL'],
        }),
      },
    });
    try {
      expect((await oort.whoami()).mode).toBe('cloud');
      const marker = `sdk-live-smoke-${randomUUID()}`;
      const saved = await oort.observe({
        user: `Remember for the SDK smoke test: the marker is ${marker}.`,
        assistant: 'Noted.',
        turnRef: marker,
      });
      const again = await oort.observe({
        user: `Remember for the SDK smoke test: the marker is ${marker}.`,
        assistant: 'Noted.',
        turnRef: marker,
      });
      expect(again.duplicate).toBe(true);
      const id = saved.memories.find((m) => m.id !== undefined)?.id;
      const r = await oort.recall(marker, { limit: 5 });
      expect(Array.isArray(r.memories)).toBe(true);
      if (id !== undefined) {
        expect(await oort.pin(id)).toMatchObject({ id, pinned: true, changed: null });
        expect(await oort.unpin(id)).toMatchObject({ id, pinned: false });
        expect(await oort.forget(id)).toEqual({ forgotten: id });
      }
    } finally {
      await oort.close();
    }
  }, 120_000);
});
