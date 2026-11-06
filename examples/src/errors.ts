import { createOort, OortError } from 'oortmem';

/** Retries what Oort marks `retryable`, waiting `retryAfter` seconds when the service sent it. */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof OortError) || !e.retryable || attempt >= tries) throw e;
      await new Promise((done) => setTimeout(done, (e.retryAfter ?? attempt) * 1000));
    }
  }
}

try {
  await using oort = await createOort({ mode: 'cloud', keySources: ['env'] });
  const r = await withRetry(() =>
    oort.observe({ user: 'Our staging database runs on port 6543.', assistant: 'Noted.' }),
  );
  console.log('saved:', r.outcome);
} catch (e) {
  if (!(e instanceof OortError)) throw e;
  // Branch on `code` first: new `reason` strings may appear in any release.
  switch (e.code) {
    case 'needs-login':
      console.error(`No usable Oort key (${e.reason}). Fix: ${e.fix}`);
      break;
    case 'refused':
      console.error(`Refused (${e.reason}): ${e.message}`);
      break;
    case 'network':
      console.error(`Oort Cloud is unreachable (${e.reason}); try again later.`);
      break;
    default:
      throw e;
  }
}
