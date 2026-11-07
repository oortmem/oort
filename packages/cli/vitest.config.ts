import { defineConfig } from 'vitest/config';

// test/no-real-npm.ts puts a stand-in npm first on every test process's PATH (CON-114).
export default defineConfig({
  test: {
    name: 'oortmem',
    setupFiles: ['./test/no-real-npm.ts'],
  },
});
