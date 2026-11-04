import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountView, statusLabel, type AccountActions } from '@/components/account/AccountView';
import { NotConfigured } from '@/components/account/AuthShell';
import { CliApprove } from '@/components/account/CliApprove';
import { clerkEnabled } from '@/lib/clerk';
import type { Overview } from '@/server/account';
import { cliCode } from '@/server/keys';

const overview = (over: Partial<Overview> = {}): Overview => ({
  plan: 'free',
  status: 'none',
  entitled: false,
  currentPeriodEnd: null,
  hasBilling: false,
  keys: [],
  usage: {
    month: '2026-11',
    saves: 1200,
    recalls: 3400,
    limits: { saves: 25_000, recalls: 50_000 },
  },
  ...over,
});

const actions = (over: Partial<AccountActions> = {}): AccountActions => ({
  subscribe: vi.fn(async () => null),
  manage: vi.fn(async () => null),
  createKey: vi.fn(async (name: string) => ({
    key: 'oort_sk_FULLSECRETKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    prefix: 'oort_sk_FULL',
    name,
  })),
  revoke: vi.fn(async () => null),
  ...over,
});

describe('account page', () => {
  it('offers Subscribe to Pro on Free, and the plain Pro line', () => {
    const a = actions();
    render(<AccountView overview={overview()} actions={a} />);
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe to Pro' }));
    expect(a.subscribe).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
    expect(
      screen.getByText(/Pro: no API keys needed; your memories stay on your machine/),
    ).toBeTruthy();
    expect(screen.getByText(/\$19\/month, VAT included where applicable/)).toBeTruthy();
  });

  it('names oort login without a Planned label', () => {
    render(<AccountView overview={overview()} actions={actions()} />);
    const keys = screen.getByRole('heading', { name: /API keys/i }).closest('section')!;
    expect(keys.textContent).toContain('oort login');
    expect(keys.textContent).not.toMatch(/planned/i);
  });

  it('offers Manage billing and hides Subscribe while Pro is active', () => {
    render(
      <AccountView
        overview={overview({ plan: 'pro', status: 'active', entitled: true, hasBilling: true })}
        actions={actions()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Manage billing' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Subscribe to Pro' })).toBeNull();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it("shows this month's saves and recalls against the plan limits", () => {
    render(<AccountView overview={overview()} actions={actions()} />);
    expect(screen.getByText('1,200 / 25,000')).toBeTruthy();
    expect(screen.getByText('3,400 / 50,000')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Saves' }).getAttribute('aria-valuenow')).toBe(
      '1200',
    );
  });

  it('shows a new key once with a copy button, and lists keys by prefix only', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <AccountView
        overview={overview({
          keys: [
            {
              id: 'k1',
              prefix: 'oort_sk_OLD1',
              name: 'Old laptop',
              createdAt: '2026-11-01T00:00:00Z',
              lastUsedAt: null,
              revokedAt: null,
            },
          ],
        })}
        actions={actions()}
      />,
    );
    expect(screen.getByText('oort_sk_OLD1…')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    const box = await screen.findByTestId('new-key');
    expect(box.textContent).toMatch('oort_sk_FULLSECRETKEY');
    expect(box.textContent).toMatch('only time it is shown');
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'oort_sk_FULLSECRETKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /hide the key/ }));
    expect(screen.queryByTestId('new-key')).toBeNull();
    expect(document.body.textContent).not.toContain('FULLSECRETKEY');
  });

  it('asks for a confirm before revoking', async () => {
    const a = actions();
    render(
      <AccountView
        overview={overview({
          keys: [
            {
              id: 'k1',
              prefix: 'oort_sk_OLD1',
              name: 'Old',
              createdAt: '2026-11-01T00:00:00Z',
              lastUsedAt: null,
              revokedAt: null,
            },
          ],
        })}
        actions={a}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(a.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(a.revoke).toHaveBeenCalledWith('k1'));
  });

  it('labels Stripe statuses in plain words', () => {
    expect(statusLabel('past_due')).toBe('Payment failed, Stripe is retrying');
    expect(statusLabel('none')).toBe('No subscription');
  });
});

describe('CLI approve page', () => {
  const SESSION = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';

  it('shows the code the terminal shows and the key name it will create', async () => {
    render(<CliApprove session={SESSION} entitled today="2026-11-04" approve={async () => null} />);
    const expected = await cliCode(SESSION);
    await waitFor(() => expect(screen.getByTestId('cli-code').textContent).toMatch(expected));
    expect(screen.getByText(/CLI on 2026-11-04/)).toBeTruthy();
  });

  it('approves, then tells the user to go back to the terminal', async () => {
    const approve = vi.fn(async () => null);
    render(<CliApprove session={SESSION} entitled today="2026-11-04" approve={approve} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/Go back to your terminal/)).toBeTruthy();
    expect(approve).toHaveBeenCalledOnce();
  });

  it('shows a refusal and lets the user try again', async () => {
    render(
      <CliApprove
        session={SESSION}
        entitled
        today="2026-11-04"
        approve={async () => 'This sign-in request expired. Run oort login again.'}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired/);
  });

  it('warns when the account has no Pro yet', () => {
    render(
      <CliApprove
        session={SESSION}
        entitled={false}
        today="2026-11-04"
        approve={async () => null}
      />,
    );
    expect(screen.getByText(/does not have Oort Pro yet/)).toBeTruthy();
  });

  it('handles a link without a session', () => {
    render(<CliApprove session="" entitled today="2026-11-04" approve={async () => null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/no sign-in request/);
  });
});

describe('without a Clerk publishable key', () => {
  it('turns sign-in off and says so plainly', () => {
    expect(clerkEnabled).toBe(false);
    render(<NotConfigured what="Sign-in" />);
    expect(screen.getByRole('heading').textContent).toMatch('Sign-in is not set up in this build');
  });
});
