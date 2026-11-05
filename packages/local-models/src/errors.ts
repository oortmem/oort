import { findModel, MODELS, type ModelRole, type ModelSpec } from './catalog.js';
import { modelDir, modelState, type ModelState } from './files.js';

export type LocalModelErrorKind = 'unknown-model' | 'wrong-role' | 'not-ready' | 'dimension';

/** A local model that cannot be used as configured; the message names the fix. */
export class LocalModelError extends Error {
  constructor(
    readonly kind: LocalModelErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'LocalModelError';
  }
}

const STATE_FIX: Record<Exclude<ModelState, 'ready'>, string> = {
  missing: 'is not downloaded',
  incomplete: 'is incompletely downloaded',
  outdated: 'was downloaded for another version of Oort',
};

/** The spec for `id` in `role`, pulled and complete, or a `LocalModelError` saying how to fix it. */
export function readyModel(
  home: string,
  role: ModelRole,
  id: string,
  custom?: ModelSpec,
): { spec: ModelSpec; dir: string } {
  const spec = custom?.id === id ? custom : findModel(id);
  const key = role === 'decide' ? 'decide model' : `${role}.model`;
  if (spec === undefined) {
    const ids = MODELS.filter((m) => m.role === role).map((m) => m.id);
    throw new LocalModelError(
      'unknown-model',
      `${key} "${id}" is not a local model; use one of ${ids.join(', ')} (oort models).`,
    );
  }
  if (spec.role !== role) {
    throw new LocalModelError('wrong-role', `${key} "${id}" is a ${spec.role} model.`);
  }
  const state = modelState(home, spec);
  if (state !== 'ready') {
    throw new LocalModelError(
      'not-ready',
      `local model ${id} ${STATE_FIX[state]}; run \`oort models pull ${id}\`.`,
    );
  }
  return { spec, dir: modelDir(home, id) };
}
