import type { ReactNode } from 'react';

/** The centred card used by the sign-in, sign-up and CLI approve pages. */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="starfield grid min-h-screen place-items-center px-4 py-12">
      <div className={`w-full ${wide ? 'max-w-lg' : 'max-w-sm'}`}>
        {children}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          <a href="/">Back to the site</a>
        </p>
      </div>
    </div>
  );
}

export function NotConfigured({ what }: { what: string }) {
  return (
    <div className="iris-border rounded-3xl bg-card p-8 text-center">
      <h1 className="text-xl font-semibold">{what} is not set up in this build</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Oort Pro accounts are being switched on. The open source engine works today without an
        account.
      </p>
    </div>
  );
}
