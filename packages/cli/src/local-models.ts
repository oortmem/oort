import type { Embedder, OortConfig, Reranker, ResolvedConfig } from '@oortmem/core';

/** `embed.provider` / `rerank.provider` for models that run on this machine. */
export const LOCAL_PROVIDER = 'local';

/** The package that runs them; optional, so `npm i -g oortmem` stays small without it. */
export const LOCAL_PACKAGE = '@oortmem/local-models';

export const LOCAL_INSTALL_HINT = `npm i -g ${LOCAL_PACKAGE}`;

/** How a store's vectors are named in its binding: `voyage/voyage-3.5-lite`, `local/bge-small-en-v1.5`. */
export function embedderId(embed: Pick<OortConfig['embed'], 'provider' | 'model'>): string {
  return `${embed.provider}/${embed.model}`;
}

/**
 * The embedder of a store written before bindings were recorded: Voyage was the only one, so
 * its vectors are Voyage's (the configured Voyage model, else the default).
 */
export function legacyEmbedderId(embed: Pick<OortConfig['embed'], 'provider' | 'model'>): string {
  return embed.provider === 'voyage' ? embedderId(embed) : 'voyage/voyage-3.5-lite';
}

/** The store's vectors come from another embedder than the configured one. */
export class EmbedderMismatchError extends Error {
  constructor(
    readonly bound: string,
    readonly active: string,
  ) {
    super(
      `your memories are embedded with ${bound}, but embed is set to ${active}: dense recall and saving are off until you run \`oort reembed\` (or switch embed back).`,
    );
    this.name = 'EmbedderMismatchError';
  }
}

type LocalModels = typeof import('@oortmem/local-models');

/** Imports the local models package, or explains how to install it. */
export async function importLocalModels(): Promise<LocalModels | Error> {
  try {
    return await import('@oortmem/local-models');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      return new Error(
        `local models need ${LOCAL_PACKAGE} (ONNX Runtime, about 115 MB): install it with \`${LOCAL_INSTALL_HINT}\`.`,
      );
    }
    return new Error(`${LOCAL_PACKAGE} could not be loaded (${(e as Error).name}).`);
  }
}

/**
 * The local embedder or reranker the config names. Construction only checks that the model was
 * pulled; nothing is loaded and nothing is downloaded (a missing model is an error naming
 * `oort models pull`).
 */
export async function loadLocal<R extends 'embed' | 'rerank'>(
  role: R,
  config: ResolvedConfig,
): Promise<{ ok: R extends 'embed' ? Embedder : Reranker } | { error: Error }> {
  const lm = await importLocalModels();
  if (lm instanceof Error) return { error: lm };
  try {
    const adapter =
      role === 'embed'
        ? lm.localEmbedder({
            home: config.home,
            model: config.embed.model,
            dimension: config.embed.dimension,
          })
        : lm.localReranker({ home: config.home, model: config.rerank.model });
    return { ok: adapter as unknown as R extends 'embed' ? Embedder : Reranker };
  } catch (e) {
    if (e instanceof lm.LocalModelError) return { error: e };
    return {
      error: new Error(`${LOCAL_PACKAGE} could not be constructed (${(e as Error).name}).`),
    };
  }
}
