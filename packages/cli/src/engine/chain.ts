import { Grant, localGrant, type Memory, type MemoryStore, type ScopeFilter } from '@oortmem/core';

/** One link of a supersede chain, as `oort inspect`, MCP `explain` and the SDK show it. */
export interface ChainLink {
  id: string;
  validFrom: string;
  validTo: string | null;
  expiredAt: string | null;
  endReason: Memory['endReason'];
  text: string;
}

const link = (m: Memory): ChainLink => ({
  id: m.id,
  validFrom: m.validFrom,
  validTo: m.validTo,
  expiredAt: m.expiredAt,
  endReason: m.endReason,
  text: m.text,
});

/**
 * The supersede chain through `m`, oldest first: `supersedes` back,
 * `supersededBy` forward. Links outside `readable` (a filter, read with its local grant, or a
 * grant: another project's memory, from before observe kept chains in one scope) are walked
 * through but not returned; `hidden` counts them.
 */
export async function supersedeChain(
  store: MemoryStore,
  m: Memory,
  readable: ScopeFilter | Grant,
): Promise<{ links: ChainLink[]; hidden: number }> {
  const grant = Grant.is(readable) ? readable : localGrant(readable);
  const seen = new Set([m.id]);
  let hidden = 0;
  const walk = async (
    start: string | null,
    next: (x: Memory) => string | null,
    add: (l: ChainLink) => void,
  ): Promise<void> => {
    for (let id = start; id !== null && !seen.has(id);) {
      seen.add(id);
      // The store answers an unknown and an out-of-scope id alike: the chain
      // continues where this view cannot follow, so the walk stops there.
      const x = await store.get(grant, id);
      if (x === null) {
        hidden++;
        break;
      }
      add(link(x));
      id = next(x);
    }
  };
  const back: ChainLink[] = [];
  const forward: ChainLink[] = [];
  await walk(
    m.supersedes,
    (x) => x.supersedes,
    (l) => back.unshift(l),
  );
  await walk(
    m.supersededBy,
    (x) => x.supersededBy,
    (l) => forward.push(l),
  );
  return { links: [...back, link(m), ...forward], hidden };
}

/** `link`, for the cloud chain walk (which reads through the API, not a store). */
export const chainLink = link;
