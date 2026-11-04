declare module 'cloudflare:workers' {
  export const env: {
    /** Waitlist database (oort-site-waitlist). */
    DB: import('./server/waitlist').D1Like;
    /** Shared Oort Pro accounts database (oort-accounts), also bound by apps/relay. */
    ACCOUNTS_DB: import('./server/d1').D1DatabaseLike;
    /** Secrets (wrangler secret put). Unset means accounts or billing are off in this build. */
    CLERK_SECRET_KEY?: string;
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    STRIPE_PRICE_PRO?: string;
  };
}

interface ImportMetaEnv {
  /** Clerk publishable key. Public by design; inlined at build time. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}
