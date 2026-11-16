import type { LabelSource } from './judgment.js';

/**
 * The `dashboard` and `connector` origins, kept only for a label source vouched for here. This
 * module is not exported from the package entry points: a server that authenticates the person
 * (the Oort Cloud dashboard) or the upstream system (a connector) imports it from inside the
 * repository. Any other caller that asks for either origin records `integration` (`labelOf`).
 */
const vouched = new WeakSet<object>();

/** `source`, marked so `labelOf` keeps a `dashboard` or `connector` origin. */
export function trustedLabel(source: LabelSource): LabelSource {
  const s: LabelSource = {
    ...source,
    ...(source.upstream !== undefined && { upstream: { ...source.upstream } }),
  };
  vouched.add(s);
  return s;
}

/** Whether `source` came from `trustedLabel`. A copy of it does not. */
export function isTrustedLabel(source: object): boolean {
  return vouched.has(source);
}
