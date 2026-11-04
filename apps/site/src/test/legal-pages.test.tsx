import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { Route as Cookies } from '@/routes/legal/cookies';
import { Route as Privacy } from '@/routes/legal/privacy';
import { Route as Subprocessors } from '@/routes/legal/subprocessors';
import { Route as Terms } from '@/routes/legal/terms';
import { Route as TermsOfService } from '@/routes/legal/terms-of-service';

/** Renders one page component inside a throwaway router, so its links work. */
async function page(route: { options: { component?: unknown } }) {
  const Component = route.options.component as () => React.JSX.Element;
  const root = createRootRoute({ component: () => <Outlet /> });
  const index = createRoute({ getParentRoute: () => root, path: '/', component: Component });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const r = render(<RouterProvider router={router} />);
  await screen.findAllByRole('heading', { level: 1 });
  return r.container.textContent ?? '';
}

const EM_DASH = String.fromCharCode(0x2014);

const NEW_COPY = [
  'routes/legal/terms-of-service.tsx',
  'routes/legal/privacy.tsx',
  'routes/legal/subprocessors.tsx',
  'routes/legal/cookies.tsx',
  'routes/legal/terms.tsx',
];

describe('legal pages for Oort Pro', () => {
  it('every page keeps the Draft banner', async () => {
    for (const r of [TermsOfService, Privacy, Subprocessors, Cookies, Terms]) {
      const text = await page(r);
      expect(text).toContain('Draft, under legal review');
      cleanup();
    }
  });

  it('Terms of service cover the subscription, cancel any time and the 14-day withdrawal', async () => {
    const text = await page(TermsOfService);
    expect(text).toMatch(/Oort Pro terms of service/);
    expect(text).toMatch(/\$19 a month/);
    expect(text).toMatch(/cancel any time/i);
    expect(text).toMatch(/14 days/);
    expect(text).toMatch(/start right away/);
    expect(text).toMatch(/lose the right of withdrawal once the service has started/);
    expect(text).toMatch(/refund the unused part/);
    expect(text).toMatch(/25,000 saves and 50,000 recalls/);
    expect(text).not.toMatch(/VAT number/);
  });

  it('the site terms of use are the site terms and link to the Pro terms', async () => {
    const text = await page(Terms);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Terms of use');
    expect(text).not.toMatch(/sign-in page/);
    const link = screen.getByRole('link', { name: /Oort Pro terms of service/ });
    expect(link.getAttribute('href')).toBe('/legal/terms-of-service');
  });

  it('privacy says what leaves your machine with Oort Pro, in plain words', async () => {
    const text = await page(Privacy);
    expect(
      screen.getByRole('heading', { name: 'What leaves your machine with Oort Pro' }),
    ).toBeTruthy();
    expect(text).toMatch(/does not store or log/);
    expect(text).toMatch(/Your memories stay/);
    for (const name of ['Clerk', 'Stripe', 'Voyage AI', 'TypeSafe', 'Anthropic', 'Cloudflare']) {
      expect(text).toContain(name);
    }
    expect(text).not.toMatch(/We set no cookies/);
  });

  it('subprocessors are exactly Cloudflare, Clerk, Stripe, Voyage AI, TypeSafe and Anthropic', async () => {
    await page(Subprocessors);
    const names = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector('strong')?.textContent ?? '')
      .filter(Boolean); // the nav and footer lists have no bold names
    expect(names).toEqual(['Cloudflare', 'Clerk', 'Stripe', 'Voyage AI', 'TypeSafe', 'Anthropic']);
  });

  it('cookies names the sign-in cookies as strictly necessary', async () => {
    const text = await page(Cookies);
    expect(text).toMatch(/strictly necessary/);
    expect(text).toMatch(/Clerk/);
  });

  it('new legal copy has no em dash', () => {
    for (const f of NEW_COPY) {
      expect(readFileSync(join(import.meta.dirname, '..', f), 'utf8')).not.toContain(EM_DASH);
    }
  });
});
