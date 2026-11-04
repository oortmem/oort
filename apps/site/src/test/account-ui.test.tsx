import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountView, statusLabel, type AccountActions } from '@/components/account/AccountView';
import { NotConfigured } from '@/components/account/AuthShell';
import { CliApprove } from '@/components/account/CliApprove';
import { clerkEnabled } from '@/lib/clerk';
import type { CliRequestView, Overview } from '@/server/account';

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
  const view = (over: Partial<CliRequestView> = {}): CliRequestView => ({
    code: 'BCDF-GHJK',
    createdAt: '2026-11-04T10:00:00.000Z',
    country: 'SE',
    os: 'macOS',
    host: 'marcus-mbp',
    keyLimitReached: false,
    ...over,
  });
  const found = (over: Partial<CliRequestView> = {}) =>
    vi.fn(async (_code: string) => ({ ok: true as const, value: view(over) }));

  const enter = (code = 'bcdf ghjk') => {
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  };

  it('asks for the code from the terminal; the page has none of its own', () => {
    render(<CliApprove entitled today="2026-11-04" lookup={found()} approve={async () => null} />);
    expect(screen.getByLabelText('Code')).toBeTruthy();
    expect(screen.queryByTestId('cli-code')).toBeNull();
  });

  it('shows when, where from and which computer, with the warning, before Approve', async () => {
    const lookup = found();
    render(<CliApprove entitled today="2026-11-04" lookup={lookup} approve={async () => null} />);
    enter();
    expect(
      await screen.findByText(/Only approve if you just ran oort login yourself/),
    ).toBeTruthy();
    expect(lookup).toHaveBeenCalledWith('bcdf ghjk');
    expect(screen.getByTestId('cli-code').textContent).toBe('BCDF-GHJK');
    expect(screen.getByTestId('cli-country').textContent).toBe('Sweden');
    expect(screen.getByTestId('cli-host').textContent).toBe('marcus-mbp');
    expect(screen.getByTestId('cli-os').textContent).toBe('macOS');
    expect(screen.getByText(/CLI on 2026-11-04/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('approves the code that was looked up, then sends the user back to the terminal', async () => {
    const approve = vi.fn(async (_code: string) => null);
    render(<CliApprove entitled today="2026-11-04" lookup={found()} approve={approve} />);
    enter();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/Go back to your terminal/)).toBeTruthy();
    expect(approve).toHaveBeenCalledWith('BCDF-GHJK');
  });

  it('shows a refusal for an unknown code and lets the user type again', async () => {
    const lookup = vi.fn(async () => ({
      ok: false as const,
      error: 'No pending sign-in request has that code.',
    }));
    render(<CliApprove entitled today="2026-11-04" lookup={lookup} approve={async () => null} />);
    enter('BCDF-GHJX');
    expect((await screen.findByRole('alert')).textContent).toMatch(/No pending/);
    expect(screen.getByLabelText('Code')).toBeTruthy();
  });

  it('shows an approve refusal', async () => {
    render(
      <CliApprove
        entitled
        today="2026-11-04"
        lookup={found()}
        approve={async () => 'This sign-in request expired. Run oort login again.'}
      />,
    );
    enter();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired/);
  });

  it('warns when the account has no Pro yet, and blocks Approve at the key limit', async () => {
    render(
      <CliApprove
        entitled={false}
        today="2026-11-04"
        lookup={found({ keyLimitReached: true, country: null, host: null })}
        approve={async () => null}
      />,
    );
    enter();
    expect(await screen.findByText(/does not have Oort Pro yet/)).toBeTruthy();
    expect(screen.getByText(/most live keys/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId('cli-country').textContent).toBe('Unknown');
    expect(screen.getByTestId('cli-host').textContent).toBe('Not reported');
  });
});

describe('without a Clerk publishable key', () => {
  it('turns sign-in off and says so plainly', () => {
    expect(clerkEnabled).toBe(false);
    render(<NotConfigured what="Sign-in" />);
    expect(screen.getByRole('heading').textContent).toMatch('Sign-in is not set up in this build');
  });
});
