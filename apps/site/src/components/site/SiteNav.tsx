import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Github } from 'lucide-react';
import { Logo } from './Logo';
import { legal } from '@/lib/legal';

const links = [
  { to: '/architecture', label: 'Architecture' },
  { to: '/explorer', label: 'Explorer' },
  { to: '/enterprise', label: 'Enterprise' },
  { to: '/pricing', label: 'Pricing' },
] as const;

export function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const on = () => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      setScrolled(window.scrollY > 24);
      setProgress(h > 0 ? window.scrollY / h : 0);
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className="pointer-events-none sticky top-0 z-50 flex justify-center px-4 pt-4">
      <div
        className={`liquid-glass pointer-events-auto relative flex w-full items-center justify-between overflow-hidden rounded-full transition-all duration-500 ease-out ${scrolled ? 'h-12 max-w-4xl px-3' : 'h-14 max-w-6xl px-4'}`}
      >
        <Logo />
        <nav className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className="rounded-full px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              activeProps={{
                className: 'rounded-full px-3.5 py-1.5 text-sm bg-foreground/10 text-foreground',
              }}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/oortmem/oort"
            className={`hidden items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-foreground lg:flex ${scrolled ? 'lg:hidden' : ''}`}
          >
            <Github className="size-3.5" /> GitHub
          </a>
          <Link
            to="/signin"
            className="hidden px-2 text-sm text-muted-foreground hover:text-foreground sm:block"
          >
            Sign in
          </Link>
          <Link
            to="/dashboard"
            className="press rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground"
          >
            Launch console
          </Link>
        </div>
        <span
          className="absolute bottom-0 left-0 h-px bg-gradient-to-r from-photon via-photon-glow to-ember"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-14 md:grid-cols-5">
        <div className="space-y-3">
          <Logo compact />
          <p className="text-sm text-muted-foreground">
            Memory that stays correct as facts change, at a cost that stays flat as history grows.
            Open source and tiered hot, warm and cold.
          </p>
        </div>
        {[
          [
            'Product',
            [
              ['/architecture', 'Architecture'],
              ['/explorer', 'Explorer (Concept)'],
              ['/pricing', 'Pricing'],
            ],
          ],
          [
            'Business',
            [
              ['/enterprise', 'Enterprise scenario'],
              ['/dashboard', 'Console demo'],
            ],
          ],
          [
            'Legal',
            [
              ['/legal/privacy', 'Privacy'],
              ['/legal/terms', 'Terms of use'],
              ['/legal/acceptable-use', 'Acceptable use'],
              ['/legal/cookies', 'Cookies'],
              ['/legal/subprocessors', 'Subprocessors'],
            ],
          ],
          [
            'Account',
            [
              ['/signin', 'Sign in'],
              ['/dashboard', 'Dashboard'],
            ],
          ],
        ].map(([title, items]) => (
          <div key={title as string}>
            <p className="mb-3 font-mono text-xs uppercase tracking-widest text-muted-foreground">
              {title as string}
            </p>
            <ul className="space-y-2 text-sm">
              {(items as [string, string][]).map(([to, label]) => (
                <li key={label}>
                  <Link to={to as '/'} className="text-foreground/80 hover:text-foreground">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border py-6 text-center font-mono text-xs text-muted-foreground">
        oort install claude-code · npm publishing is coming · oortcloud.dev · {legal.generalEmail}
      </div>
    </footer>
  );
}
