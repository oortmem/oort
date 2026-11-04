import { createFileRoute } from '@tanstack/react-router';
import { handleCliCreate } from '@/server/cli-session';
import { createRateLimiter } from '@/server/waitlist';

// Fallback when the Rate Limiting binding is absent (local dev): per isolate, in memory only.
const local = createRateLimiter(10, 60_000);

// `oort login` starts here. See src/server/cli-session.ts. The caller's IP is used only as the
// rate-limit key and never stored; the country comes from Cloudflare's request.cf.
export const Route = createFileRoute('/api/cli/session/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const cf = (request as Request & { cf?: { country?: unknown } }).cf;
        return handleCliCreate(request, {
          db: env.ACCOUNTS_DB,
          origin: new URL(request.url).origin,
          country: typeof cf?.country === 'string' ? cf.country : null,
          allow: async () =>
            env.CLI_SESSION_LIMITER
              ? (await env.CLI_SESSION_LIMITER.limit({ key: `ip:${ip}` })).success
              : local(ip, Date.now()),
        });
      },
    },
  },
});
