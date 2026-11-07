import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'examples',
    // no-real-npm: the skill test spawns the CLI; no test ever reaches the real npm (PR #78, M4).
    setupFiles: ['./test/no-network.ts', '../packages/cli/test/no-real-npm.ts'],
    testTimeout: 30_000,
  },
});
