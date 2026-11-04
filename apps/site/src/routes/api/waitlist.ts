import { createFileRoute } from '@tanstack/react-router';
import { createRateLimiter, handleWaitlist } from '@/server/waitlist';

// Per isolate and in memory only. Never written anywhere.
const allow = createRateLimiter();

export const Route = createFileRoute('/api/waitlist')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        return handleWaitlist(request, { db: env.DB, allow });
      },
    },
  },
});
