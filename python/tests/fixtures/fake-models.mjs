// Test-only: `node --import <this file> packages/cli/dist/main.js serve` runs the real, built
// `oort serve` with the SDK's deterministic model fakes (packages/cli/test/helpers/sdk-fakes.ts:
// a hash embedder, a rule decider, an echo writer) in place of the vendor adapters, so writes work
// with no key and no network. The vendor packages are only ever loaded by a dynamic import in
// wire.js, by name; this redirects those four names to this file. The daemon still needs a key
// in its environment for each role (any value: the fakes never use it).
import { registerHooks } from 'node:module';
import { fakeAdapters } from '../../../packages/cli/test/helpers/sdk-fakes.ts';

const VENDOR = new Set([
  '@oortmem/embed-voyage',
  '@oortmem/rerank-voyage',
  '@oortmem/decide-jev',
  '@oortmem/writer',
]);

registerHooks({
  resolve(specifier, context, next) {
    if (VENDOR.has(specifier)) return { url: import.meta.url, shortCircuit: true };
    return next(specifier, context);
  },
});

const fakes = fakeAdapters();
export const voyageEmbedder = () => fakes.embed;
export const voyageReranker = () => fakes.rerank;
export const jevDecider = () => fakes.decide;
export const anthropicWriter = () => fakes.write;
