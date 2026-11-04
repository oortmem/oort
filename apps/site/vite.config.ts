import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

// The Clerk publishable key is public and inlined at build time. For local dev it can live in
// .dev.vars next to the server secrets; only this one VITE_ name is read from that file.
// An explicit environment variable always wins (production builds set it).
const PUBLIC_KEY = 'VITE_CLERK_PUBLISHABLE_KEY';
if (!process.env[PUBLIC_KEY] && existsSync('.dev.vars')) {
  const line = readFileSync('.dev.vars', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${PUBLIC_KEY}=`));
  if (line) process.env[PUBLIC_KEY] = line.slice(PUBLIC_KEY.length + 1).trim();
}

export default defineConfig({
  // Cloudflare Web Analytics token. Unset means no beacon is added.
  define: { __CF_BEACON_TOKEN__: JSON.stringify(process.env['CF_BEACON_TOKEN'] ?? '') },
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
