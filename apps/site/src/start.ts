import { clerkMiddleware } from '@clerk/tanstack-react-start/server';
import { createStart, createCsrfMiddleware, createMiddleware } from '@tanstack/react-start';

import { renderErrorPage } from './lib/error-page';
import { logStatus } from './lib/log';

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  const started = Date.now();
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === 'object' && 'statusCode' in error) {
      throw error;
    }
    // Status and timing only: the error itself can hold request data.
    logStatus(500, Date.now() - started);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
});

// Start installs this automatically when src/start.ts is absent; defining the
// file opts out, so re-add it explicitly to keep server functions protected
// from cross-site requests.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
});

// Clerk reads CLERK_SECRET_KEY from process.env (filled from Worker secrets by nodejs_compat) and
// throws on every request without it, so it is only installed once the secret is set. Until then
// the site works and the account pages say accounts are not set up.
const clerkConfigured = () =>
  typeof process !== 'undefined' && Boolean(process.env?.['CLERK_SECRET_KEY']);

export const startInstance = createStart(() => ({
  requestMiddleware: [
    errorMiddleware,
    csrfMiddleware,
    ...(clerkConfigured() ? [clerkMiddleware()] : []),
  ],
}));
