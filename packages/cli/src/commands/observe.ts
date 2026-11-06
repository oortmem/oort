import { privacyStatement } from '../wire.js';
import { z } from 'zod';
import { observe, scrubObservation, type Observation } from '@oortmem/core';
import {
  Refusal,
  cloudOf,
  safeJson,
  writePath,
  withWired,
  type Ctx,
  refuseStarInCloud,
} from '../util.js';

export interface ObserveOptions {
  user?: string;
  assistant?: string;
  dryRun?: boolean;
  /** Accepted and ignored: observe always prints JSON. */
  json?: boolean;
}

const ObservationInput = z.strictObject({
  userText: z.string(),
  assistantText: z.string(),
  toolSummaries: z.array(z.string()).default([]),
  sessionId: z.string().optional(),
  turnRef: z.string().optional(),
  projectId: z.string().optional(),
  at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'not an ISO timestamp')
    .optional(),
});

/** One turn as an Observation, the way `oort observe --user --assistant` builds it. */
export function turnObservation(
  userText: string,
  assistantText: string,
  at = new Date().toISOString(),
): Observation {
  return { userText, assistantText, toolSummaries: [], at };
}

async function readObservation(opts: ObserveOptions, ctx: Ctx): Promise<Observation> {
  const at = new Date().toISOString();
  if (opts.user !== undefined || opts.assistant !== undefined) {
    if (opts.user === undefined || opts.assistant === undefined) {
      throw new Refusal('--user and --assistant go together.');
    }
    return turnObservation(opts.user, opts.assistant, at);
  }
  if (ctx.io.stdinIsTTY) {
    throw new Refusal('Pipe an Observation as JSON on stdin, or pass --user and --assistant.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await ctx.io.readStdin());
  } catch {
    throw new Refusal('The input on stdin is not valid JSON.');
  }
  const parsed = ObservationInput.safeParse(raw);
  if (!parsed.success) {
    // Paths and codes only: the issue messages could quote the input.
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new Refusal(`The input on stdin is not an Observation (check: ${where}).`);
  }
  const { at: given, ...rest } = parsed.data;
  const obs: Observation = { ...rest, at: given ?? at };
  return obs;
}

/**
 * `oort observe`: runs the write path on one observation. `--dry-run` only
 * scrubs it and reports what would be redacted or dropped; it opens no store
 * and calls no adapter.
 */
export async function observeCommand(opts: ObserveOptions, ctx: Ctx): Promise<number> {
  const obs = await readObservation(opts, ctx);
  if (opts.dryRun === true) {
    const s = scrubObservation(obs);
    const report = { dropped: s.dropped, redactions: s.redactions };
    ctx.io.out(`${safeJson(report)}\n`);
    return 0;
  }
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (cloud !== undefined) {
      refuseStarInCloud(w);
      const result = await cloud.observe({
        ...(w.scope.projectId !== undefined && {
          project: w.scope.projectId,
          ...privacyStatement(w),
        }),
        observation: {
          user: obs.userText,
          assistant: obs.assistantText,
          at: obs.at,
          ...(obs.sessionId !== undefined && { session: obs.sessionId }),
          ...(obs.toolSummaries.length > 0 && { tools: obs.toolSummaries }),
        },
      });
      ctx.io.out(`${safeJson(result)}\n`);
      return 0;
    }
    const adapters = writePath(w, 'oort observe');
    const result = await observe(obs, w.scope, {
      store: w.store,
      ...adapters,
      config: w.config,
      harness: 'cli',
      home: w.agent.home,
    });
    ctx.io.out(`${safeJson(result)}\n`);
    return 0;
  });
}
