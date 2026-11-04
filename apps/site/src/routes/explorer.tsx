import { createFileRoute, redirect } from '@tanstack/react-router';

// The Explorer app concept is not on the live site any more; it is kept as an internal reference.
// Old links and search results land on the home page.
export const Route = createFileRoute('/explorer')({
  beforeLoad: () => {
    throw redirect({ to: '/', statusCode: 301 });
  },
});
