import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tsConfigPaths(),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    dedupe: ['react', 'react-dom', '@tanstack/react-router'],
  },
});
