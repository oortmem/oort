import { createFileRoute } from '@tanstack/react-router';
import { handleCliPoll } from '@/server/cli-session';

// Polled by `oort login`. Authenticated by the random session id itself, which only the CLI
// and the browser tab it opened know. See src/server/cli-session.ts.
export const Route = createFileRoute('/api/cli/session/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { env } = await import('cloudflare:workers');
        return handleCliPoll(params.id, { db: env.ACCOUNTS_DB });
      },
    },
  },
});
