import { createFileRoute } from '@tanstack/react-router';
import { handleStripeWebhook } from '@/server/stripe-webhook';

export const Route = createFileRoute('/api/stripe/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        const secret = env.STRIPE_WEBHOOK_SECRET;
        if (!env.STRIPE_SECRET_KEY || !secret || !env.STRIPE_PRICE_PRO) {
          return Response.json({ error: 'Billing is not set up yet.' }, { status: 503 });
        }
        const { createStripe } = await import('@/server/stripe');
        const { stripe, verify } = await createStripe(env.STRIPE_SECRET_KEY);
        return handleStripeWebhook(request, {
          db: env.ACCOUNTS_DB,
          stripe,
          verify: (payload, signature) => verify(payload, signature, secret),
          pricePro: env.STRIPE_PRICE_PRO,
        });
      },
    },
  },
});
