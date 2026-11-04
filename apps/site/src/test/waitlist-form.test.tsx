import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WaitlistForm } from '@/components/site/WaitlistForm';

async function show() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <WaitlistForm source="pricing" id="early-access" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
  await act(() => router.load());
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WaitlistForm', () => {
  it('is a labelled section with the email field, consent and privacy link', async () => {
    await show();
    expect(screen.getByRole('region', { name: /be first in/i })).toHaveAttribute(
      'id',
      'early-access',
    );
    expect(screen.getByLabelText('Email')).toBeRequired();
    expect(screen.getByRole('checkbox', { name: /agree to be emailed/i })).toBeRequired();
    expect(screen.getByRole('link', { name: 'privacy notice' })).toHaveAttribute(
      'href',
      '/legal/privacy',
    );
  });

  it('posts email, consent and the page, then thanks the user', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await show();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.dev' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /join/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Thanks/));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/waitlist');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@b.dev',
      consent: true,
      website: '',
      source: 'pricing',
    });
  });

  it('shows the server error as an alert', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"ok":false,"error":"Enter a valid email address."}', { status: 400 }),
      ),
    );
    await show();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.dev' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /join/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.'),
    );
  });
});
