// NOTE: duplicated in @oortmem/rerank-voyage (src/http.ts). It is small, and the
// two packages must not depend on each other; keep both copies in sync.

export type VoyageErrorKind =
  'auth' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'bad-response';

/** A failed Voyage call. The message never includes the API key or request text. */
export class VoyageError extends Error {
  readonly status: number | undefined;
  readonly kind: VoyageErrorKind;

  constructor(kind: VoyageErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'VoyageError';
    this.kind = kind;
    this.status = status;
  }
}

const TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 500;
const MAX_RETRY_MS = 5_000;

function retryDelay(res: Response): number {
  const raw = res.headers.get('retry-after');
  const secs = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(secs) || secs < 0) return DEFAULT_RETRY_MS;
  return Math.min(secs * 1000, MAX_RETRY_MS);
}

function classify(status: number): VoyageError {
  if (status === 401 || status === 403) {
    return new VoyageError('auth', `Voyage rejected the credentials (HTTP ${status})`, status);
  }
  if (status === 429) return new VoyageError('rate-limit', 'Voyage rate limit (HTTP 429)', status);
  if (status >= 500)
    return new VoyageError('server', `Voyage server error (HTTP ${status})`, status);
  return new VoyageError('bad-response', `Voyage request failed (HTTP ${status})`, status);
}

/** POST JSON with a 10 s timeout and one retry on 429/5xx. Returns the parsed body. */
export async function postJson(
  fetchFn: typeof fetch,
  url: string,
  apiKey: string,
  body: unknown,
): Promise<unknown> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new VoyageError('timeout', `Voyage request timed out after ${TIMEOUT_MS} ms`);
      }
      throw new VoyageError('network', 'Voyage request failed (network error)');
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new VoyageError('bad-response', 'Voyage returned a non-JSON response', res.status);
      }
    }
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, retryDelay(res)));
      continue;
    }
    throw classify(res.status);
  }
}
