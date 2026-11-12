import { createAnthropic } from '@ai-sdk/anthropic';
import {
  APICallError,
  AISDKError,
  NoObjectGeneratedError,
  Output,
  RetryError,
  TypeValidationError,
  generateText,
  type LanguageModel,
} from 'ai';
import { z } from 'zod';
import {
  MissingCredentialError,
  scrub,
  type MemoryType,
  type MemoryWriter,
  type WrittenMemory,
} from '@oortmem/core';
import {
  REWRITE_SYSTEM_PROMPT,
  WRITER_MANY_SYSTEM_PROMPT,
  WRITER_SYSTEM_PROMPT,
  buildRewritePrompt,
  buildWriterManyPrompt,
  buildWriterPrompt,
} from './prompt.js';

export {
  REWRITE_SYSTEM_PROMPT,
  WRITER_MANY_SYSTEM_PROMPT,
  WRITER_SYSTEM_PROMPT,
  buildRewritePrompt,
  buildWriterManyPrompt,
  buildWriterPrompt,
};

/** Default Anthropic model for `anthropicWriter` (Claude Haiku 5.5). */
const DEFAULT_MODEL = 'claude-haiku-5-5';
// Headroom for the JSON answer; thinking is disabled below, but other providers may still spend tokens.
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

const outputSchema = z.object({
  text: z.string().min(1).max(600),
  // The stub target is 200 chars (LIMITS, the prompt's 35 tokens); up to 600 is accepted
  // and cut at a word boundary in `scrubbed`, because a retry did not reliably shorten it.
  stub: z.string().min(1).max(600),
  entities: z.array(z.string().min(1).max(60)).max(12),
  type: z.enum(['semantic', 'episodic', 'procedural', 'preference']),
});

type WriterOutput = z.infer<typeof outputSchema>;

/** `writeMany`'s answer: 1 to `max` memories, each within the single-memory limits. */
const manySchema = (max: number) => z.object({ memories: z.array(outputSchema).min(1).max(max) });

/** Human-readable limit per field, used in the corrective retry message. */
const LIMITS: Record<string, string> = {
  text: 'text must be 1 to 600 characters',
  stub: 'stub must be 1 to 200 characters',
  entities: 'entities must be at most 12 items, each 1 to 60 characters',
  type: 'type must be one of semantic, episodic, procedural, preference',
};

export type WriterErrorKind =
  'auth' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'bad-response';

/** A failed provider call. The message never includes observation, prior or model text, or the key. */
export class WriterError extends Error {
  readonly kind: WriterErrorKind;
  readonly status: number | undefined;
  /** The Oort Pro relay's own message for a refusal (relay mode only); never a vendor body. */
  readonly relayMessage: string | undefined;

  constructor(kind: WriterErrorKind, status?: number, message?: string, relayMessage?: string) {
    super(
      message ??
        `Memory writer call failed (${kind}${status === undefined ? '' : `, HTTP ${status}`})`,
    );
    this.name = 'WriterError';
    this.kind = kind;
    this.status = status;
    this.relayMessage = relayMessage;
  }
}

/** A relay refusal that waiting cannot clear (the monthly cap); thrown from fetch so the SDK does not retry it. */
class RelayCapError extends Error {
  constructor(readonly relayMessage: string | undefined) {
    super('Oort Pro cap reached');
    this.name = 'RelayCapError';
  }
}

/** The `error` string of a relay refusal body, cleaned and cut short; undefined for anything else. */
function relayMessageFrom(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const msg = (JSON.parse(raw) as { error?: unknown } | null)?.error;
    if (typeof msg !== 'string') return undefined;
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    const clean = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return clean === '' ? undefined : clean.slice(0, 400);
  } catch {
    return undefined;
  }
}

const rateLimit = (relayMessage: string | undefined): WriterError =>
  relayMessage === undefined
    ? new WriterError('rate-limit', 429)
    : new WriterError('rate-limit', 429, relayMessage, relayMessage);

/** The model's output failed the schema twice. Carries field names only, never text. */
export class WriterOutputError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`Memory writer output failed schema validation (fields: ${fields.join(', ')})`);
    this.name = 'WriterOutputError';
    this.fields = fields;
  }
}

function fromStatus(status: number): WriterError {
  if (status === 401 || status === 403) return new WriterError('auth', status);
  if (status === 408 || status === 504) return new WriterError('timeout', status);
  if (status === 429) return new WriterError('rate-limit', status);
  if (status >= 500) return new WriterError('server', status);
  return new WriterError('bad-response', status);
}

/**
 * Maps anything the SDK or provider throws to a WriterError, dropping its message and cause.
 * With `relay`, a 429's body is the relay's own message, which is kept.
 */
function wrap(e: unknown, relay = false): WriterError {
  if (e instanceof WriterError) return e;
  if (e instanceof RelayCapError) return rateLimit(e.relayMessage);
  if (RetryError.isInstance(e)) return wrap(e.lastError, relay);
  if (APICallError.isInstance(e)) {
    if (e.statusCode === 429 && relay) return rateLimit(relayMessageFrom(e.responseBody));
    return e.statusCode === undefined ? new WriterError('network') : fromStatus(e.statusCode);
  }
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return new WriterError('timeout');
  if (name === 'AI_LoadAPIKeyError') return new WriterError('auth');
  if (AISDKError.isInstance(e)) return new WriterError('bad-response');
  return new WriterError('bad-response', undefined, 'Memory writer internal error (bad-response)');
}

/** True for the failures a corrective retry can fix: the model's output did not validate. */
function isSchemaFailure(e: unknown): boolean {
  return NoObjectGeneratedError.isInstance(e) || TypeValidationError.isInstance(e);
}

/** Truncated or declined output cannot be fixed by a field-level retry. */
function throwIfUnusable(e: unknown): void {
  if (!NoObjectGeneratedError.isInstance(e)) return;
  if (e.finishReason === 'length') {
    throw new WriterError(
      'bad-response',
      undefined,
      'Memory writer model output truncated (bad-response)',
    );
  }
  if (e.finishReason === 'content-filter') {
    throw new WriterError('bad-response', undefined, 'Memory writer model declined (bad-response)');
  }
}

/** Names the schema fields that failed, from the raw model text if it parses; never returns text. */
function failingFields(e: unknown, schema: z.ZodType = outputSchema): string[] {
  let raw: string | undefined;
  if (NoObjectGeneratedError.isInstance(e)) raw = e.text;
  else if (TypeValidationError.isInstance(e)) {
    raw = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
  }
  if (raw !== undefined) {
    try {
      const r = schema.safeParse(JSON.parse(raw));
      if (!r.success) {
        const fields = new Set<string>();
        for (const issue of r.error.issues) fields.add(fieldName(issue.path));
        return [...fields];
      }
    } catch {
      // Not JSON at all.
    }
  }
  return ['output'];
}

/** `text`, or `memories[2].text` for a field inside the `writeMany` array. */
function fieldName(p: readonly PropertyKey[]): string {
  if (p.length === 0) return 'output';
  if (p[0] !== 'memories') return typeof p[0] === 'string' ? p[0] : 'output';
  if (p.length === 1 || typeof p[1] !== 'number') return 'memories';
  return typeof p[2] === 'string' ? `memories[${p[1]}].${p[2]}` : `memories[${p[1]}]`;
}

/** The limit for a field name as `fieldName` writes it. */
function limitOf(f: string, max: number): string | undefined {
  if (f === 'memories') return `memories must hold 1 to ${max} items`;
  const leaf = f.replace(/^memories\[\d+\]\.?/, '');
  return LIMITS[leaf];
}

function correctionMany(fields: string[], max: number): string {
  const named = fields.map(
    (f) =>
      limitOf(f, max) ??
      'the output must be one JSON object {"memories": [...]} matching the schema',
  );
  return (
    `Your previous answer failed validation on: ${fields.join(', ')}. Limits: ${named.join('; ')}. ` +
    `Write the memories again within these limits. When a memory's text would be longer than 600 ` +
    `characters, split it into two or more memories, one fact each, at most ${max} in total.`
  );
}

function correction(fields: string[]): string {
  const named = fields.map(
    (f) => LIMITS[f] ?? 'the output must be a single JSON object matching the schema',
  );
  return `Your previous answer failed validation on: ${fields.join(', ')}. Limits: ${named.join('; ')}. Write the memory again within these limits.`;
}

// Defense in depth: the writer is told never to emit secrets, but scrub its output anyway.
// If scrubbing changes anything the scrubbed value is returned (an entity that changed is dropped).
// The MemoryWriter contract has no debug field, so the redaction count is not surfaced.
function fit(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut).trimEnd();
}

function scrubField(s: string, max: number): string {
  const r = scrub(s).text;
  const out = r === s ? s : fit(r, max);
  return out === '' ? 'A credential was configured.' : out;
}

function scrubbed(o: WriterOutput): {
  text: string;
  stub: string;
  entities: string[];
  type: MemoryType;
} {
  return {
    text: scrubField(o.text, 600),
    stub: fit(scrubField(o.stub, 200), 200),
    entities: o.entities.filter((x) => scrub(x).text === x),
    type: o.type,
  };
}

/** A MemoryWriter over any AI SDK language model. Only this package talks to a provider. */
export function aiSdkWriter(opts: {
  model: LanguageModel;
  maxOutputTokens?: number;
  /** The AI SDK's retries per call (its default is 2). */
  maxRetries?: number;
  /** The model is served by the Oort Pro relay: a 429's body is its message, and is kept. */
  relay?: boolean;
}): MemoryWriter {
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  async function attempt(
    messages: { role: 'user'; content: string }[],
    system = WRITER_SYSTEM_PROMPT,
  ): Promise<WriterOutput> {
    return generate(messages, system, outputSchema);
  }

  /** One memory from `content` under `system`, with one corrective retry for a schema failure. */
  async function one(content: string, system: string): Promise<WrittenMemory> {
    const user = { role: 'user' as const, content };
    let first: unknown;
    try {
      return scrubbed(await attempt([user], system));
    } catch (e) {
      if (!isSchemaFailure(e)) throw wrap(e, opts.relay === true);
      throwIfUnusable(e);
      first = e;
    }
    const fields = failingFields(first);
    try {
      return scrubbed(await attempt([user, { role: 'user', content: correction(fields) }], system));
    } catch (e) {
      if (!isSchemaFailure(e)) throw wrap(e, opts.relay === true);
      throwIfUnusable(e);
      throw new WriterOutputError(failingFields(e));
    }
  }

  async function generate<T>(
    messages: { role: 'user'; content: string }[],
    system: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const { output } = await generateText({
      model: opts.model,
      system,
      messages,
      output: Output.object({ schema }),
      // No sampling parameters: Claude Haiku 5.5 rejects non-default values, and the defaults suit this task.
      providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
      maxOutputTokens,
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
    });
    return output;
  }

  return {
    async write(obs, action, prior) {
      if (action !== 'ADD' && prior === undefined) {
        throw new TypeError(`MemoryWriter.write: ${action} requires a prior memory`);
      }
      return one(buildWriterPrompt(obs, action, prior), WRITER_SYSTEM_PROMPT);
    },

    async rewriteWithout(memory, forgotten) {
      const w = await one(buildRewritePrompt(memory, forgotten), REWRITE_SYSTEM_PROMPT);
      // The memory keeps its own type (a judgment's too, which the writer's schema cannot name).
      return { ...w, type: memory.type };
    },

    async writeMany(obs, max): Promise<WrittenMemory[]> {
      const cap = Math.max(1, Math.floor(max));
      const schema = manySchema(cap);
      const user = { role: 'user' as const, content: buildWriterManyPrompt(obs, cap) };
      const run = async (extra?: string) =>
        (
          await generate(
            extra === undefined ? [user] : [user, { role: 'user', content: extra }],
            WRITER_MANY_SYSTEM_PROMPT,
            schema,
          )
        ).memories.map(scrubbed);
      let retry: string;
      try {
        return await run();
      } catch (e) {
        if (!isSchemaFailure(e)) throw wrap(e, opts.relay === true);
        if (NoObjectGeneratedError.isInstance(e) && e.finishReason === 'length') {
          // Several memories can outgrow the token budget: ask once for fewer, shorter ones.
          retry =
            `Your previous answer was cut off before it finished. Write fewer, shorter memories: ` +
            `at most ${Math.max(1, Math.ceil(cap / 2))}, each text well under 600 characters.`;
        } else {
          throwIfUnusable(e);
          retry = correctionMany(failingFields(e, schema), cap);
        }
      }
      try {
        return await run(retry);
      } catch (e) {
        if (!isSchemaFailure(e)) throw wrap(e, opts.relay === true);
        throwIfUnusable(e);
        throw new WriterOutputError(failingFields(e, schema));
      }
    },
  };
}

export interface AnthropicWriterOptions {
  /** Sent as `x-api-key`. Defaults to `process.env.ANTHROPIC_API_KEY`; ignored with `authToken`. */
  apiKey?: string;
  /**
   * Sent as `Authorization: Bearer` instead of `apiKey`. The Oort Pro relay takes the Oort key
   * this way (it accepts `x-api-key` too).
   */
  authToken?: string;
  /**
   * The API root, including `/v1` (default `https://api.anthropic.com/v1`). The Oort Pro relay
   * is `https://relay.oortcloud.dev/v1/anthropic/v1`.
   */
  baseURL?: string;
  model?: string;
  /**
   * The model is served by the Oort Pro relay. A 429 with `Retry-After` is retried once, as
   * before; a 429 without it (the monthly cap) is not retried at all, and the relay's message is
   * kept on the error as `relayMessage`.
   */
  relay?: boolean;
  /** For tests. */
  fetch?: typeof fetch;
}

/** Anthropic-backed writer. Throws MissingCredentialError at construction when no key is available. */
export function anthropicWriter(opts: AnthropicWriterOptions = {}): MemoryWriter {
  const relay = opts.relay === true;
  const base = opts.fetch ?? globalThis.fetch;
  // The AI SDK retries every 429. Through the relay, one without Retry-After is the monthly cap:
  // throwing from fetch is the one way to stop the SDK from retrying it.
  const capAware: typeof fetch = async (input, init) => {
    const res = await base(input, init);
    if (res.status !== 429 || res.headers.has('retry-after')) return res;
    throw new RelayCapError(relayMessageFrom(await res.text().catch(() => undefined)));
  };
  const extra = {
    ...(opts.baseURL !== undefined && { baseURL: opts.baseURL }),
    ...(relay ? { fetch: capAware } : opts.fetch !== undefined && { fetch: opts.fetch }),
  };
  const sdk = relay ? { relay: true, maxRetries: 1 } : {};
  if (opts.authToken !== undefined && opts.authToken !== '') {
    const anthropic = createAnthropic({ authToken: opts.authToken, ...extra });
    return aiSdkWriter({ model: anthropic(opts.model ?? DEFAULT_MODEL), ...sdk });
  }
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw new MissingCredentialError('ANTHROPIC_API_KEY', 'writer.apiKey');
  }
  const anthropic = createAnthropic({ apiKey, ...extra });
  return aiSdkWriter({ model: anthropic(opts.model ?? DEFAULT_MODEL), ...sdk });
}
