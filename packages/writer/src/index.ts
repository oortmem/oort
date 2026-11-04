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
import { MissingCredentialError, scrub, type MemoryType, type MemoryWriter } from '@oortmem/core';
import { WRITER_SYSTEM_PROMPT, buildWriterPrompt } from './prompt.js';

export { WRITER_SYSTEM_PROMPT, buildWriterPrompt };

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
function failingFields(e: unknown): string[] {
  let raw: string | undefined;
  if (NoObjectGeneratedError.isInstance(e)) raw = e.text;
  else if (TypeValidationError.isInstance(e)) {
    raw = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
  }
  if (raw !== undefined) {
    try {
      const r = outputSchema.safeParse(JSON.parse(raw));
      if (!r.success) {
        const fields = new Set<string>();
        for (const issue of r.error.issues) {
          const head = issue.path[0];
          fields.add(typeof head === 'string' ? head : 'output');
        }
        return [...fields];
      }
    } catch {
      // Not JSON at all.
    }
  }
  return ['output'];
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

  async function attempt(messages: { role: 'user'; content: string }[]): Promise<WriterOutput> {
    const { output } = await generateText({
      model: opts.model,
      system: WRITER_SYSTEM_PROMPT,
      messages,
      output: Output.object({ schema: outputSchema }),
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
      const user = { role: 'user' as const, content: buildWriterPrompt(obs, action, prior) };
      let first: unknown;
      try {
        return scrubbed(await attempt([user]));
      } catch (e) {
        if (!isSchemaFailure(e)) throw wrap(e, opts.relay === true);
        throwIfUnusable(e);
        first = e;
      }
      const fields = failingFields(first);
      try {
        return scrubbed(await attempt([user, { role: 'user', content: correction(fields) }]));
      } catch (e) {
        if (!isSchemaFailure(e)) throw wrap(e, opts.relay === true);
        throwIfUnusable(e);
        throw new WriterOutputError(failingFields(e));
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
