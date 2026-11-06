import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'examples',
    setupFiles: ['./test/no-network.ts'],
    testTimeout: 30_000,
  },
});
