import { defineConfig } from 'vitest/config';

// The widget tests import src/widgets.generated.ts, which the build writes; regenerate it first.
export default defineConfig({
  test: {
    name: 'mcp',
    globalSetup: ['./scripts/build-widgets.mjs'],
  },
});
