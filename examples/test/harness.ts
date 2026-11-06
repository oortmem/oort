import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fakeCloud, type FakeCloud } from '../../packages/cli/test/helpers/fake-cloud.js';
import { fakeAdapters } from '../../packages/cli/test/helpers/sdk-fakes.js';
import type { Oort, OortOptions } from '../../packages/cli/src/sdk/types.js';

type CreateWith = (options: OortOptions, internals: object) => Promise<Oort>;

/**
 * Where an example's `createOort()` lands in a test. Local mode (and `auto`, which finds no
 * `cloud.json` in the temporary home) gets the SDK's deterministic model fakes and a temporary
 * home; cloud mode gets the shared fake Oort Cloud and a fake key. The example's own options are
 * kept, so their validation still runs; only `home`, `cwd`, `env` and `fetch` are the test's.
 */
export interface Harness {
  root: string;
  home: string;
  cloud: FakeCloud;
  /** Cloud mode: false leaves `OORT_API_KEY` unset. */
  withKey: boolean;
  /** Every option object an example passed to `createOort`. */
  calls: OortOptions[];
  create(options: OortOptions | undefined, createWith: CreateWith): Promise<Oort>;
  /** A handle on the same home (or fake cloud), to look at what an example left behind. */
  open(options: OortOptions, createWith: CreateWith): Promise<Oort>;
}

export function newHarness(): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oort-examples-')));
  const key = ['oort', 'sk', 'examples'.padEnd(43, 'X')].join('_');
  const h: Harness = {
    root,
    home: path.join(root, 'home'),
    cloud: fakeCloud(key),
    withKey: true,
    calls: [],
    async create(options = {}, createWith) {
      h.calls.push(options);
      return h.open(options, createWith);
    },
    async open(options, createWith) {
      const env: Record<string, string> = { HOME: root, OORT_NO_KEYCHAIN: '1' };
      if (options.mode === 'cloud') {
        if (h.withKey) env['OORT_API_KEY'] = key;
        return createWith({ ...options, cwd: root, env, fetch: h.cloud.fetch }, {});
      }
      return createWith({ ...options, home: h.home, cwd: root, env }, { adapters: fakeAdapters() });
    },
  };
  return h;
}

const SRC = path.resolve(import.meta.dirname, '../src');
let runs = 0;

/**
 * Runs an example module afresh and captures its output. A query makes each run a new instance of
 * the example alone (`lang.ts` keeps it TypeScript); everything it imports is shared with the
 * test, so the engine's modules exist once, as in a real process.
 */
export async function runExample(
  file: string,
): Promise<{ module: Record<string, unknown>; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const show = (a: unknown[]) =>
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log = (...a: unknown[]) => void out.push(show(a));
  console.error = (...a: unknown[]) => void err.push(show(a));
  try {
    const module = (await import(
      /* @vite-ignore */ `${SRC}/${file}?run=${++runs}&lang.ts`
    )) as Record<string, unknown>;
    return { module, out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}
