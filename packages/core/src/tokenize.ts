/**
 * The lexical tokeniser every store uses, so all stores agree on what a token
 * is. Lowercase, split on anything that is not a letter, digit, `-`, `_` or
 * `.`, then trim those joiners from token ends: `auth-service-8080` stays one
 * token, but a sentence-final `8080.` becomes `8080`.
 */
export function tokenizeLexical(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}\-_.]+/u)
    .map((t) => t.replace(/^[-_.]+|[-_.]+$/g, ''))
    .filter((t) => t.length > 0);
}
