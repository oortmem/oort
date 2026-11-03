import { defineConfig } from 'vitest/config';

// The bench tests seed 10,000 memories; `--expose-gc` lets them collect garbage
// between phases so RSS readings are not noise from unreclaimed heap.
export default defineConfig({
  test: {
    name: 'bench',
    pool: 'forks',
    execArgv: ['--expose-gc'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
