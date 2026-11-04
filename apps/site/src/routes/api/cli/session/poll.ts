import { createFileRoute } from '@tanstack/react-router';
import { handleCliPoll } from '@/server/cli-session';

// Polled by `oort login` with its secret in the body, never in a URL. Read-only until approved.
export const Route = createFileRoute('/api/cli/session/poll')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        return handleCliPoll(request, { db: env.ACCOUNTS_DB });
      },
    },
  },
});
