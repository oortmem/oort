import { useState } from 'react';
import {
  Building2,
  Check,
  Globe,
  Mail,
  MoreHorizontal,
  Search,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';

type Role = 'Owner' | 'Admin' | 'Developer' | 'Viewer';
type Member = {
  name: string;
  email: string;
  role: Role;
  team: string;
  active: string;
  online?: boolean;
};

const initialMembers: Member[] = [
  {
    name: 'Maya Chen',
    email: 'maya@acme.example',
    role: 'Owner',
    team: 'Platform',
    active: 'Now',
    online: true,
  },
  {
    name: 'Jonas Weber',
    email: 'jonas@acme.example',
    role: 'Admin',
    team: 'Platform',
    active: '12m ago',
    online: true,
  },
  {
    name: 'Priya Nair',
    email: 'priya@acme.example',
    role: 'Developer',
    team: 'Agents',
    active: '1h ago',
  },
  {
    name: 'Sam Ortiz',
    email: 'sam@acme.example',
    role: 'Viewer',
    team: 'Finance',
    active: '3d ago',
  },
  {
    name: 'Lea Martin',
    email: 'lea@acme.example',
    role: 'Developer',
    team: 'Agents',
    active: 'Yesterday',
  },
];
const roles: Role[] = ['Owner', 'Admin', 'Developer', 'Viewer'];
const tabs = ['Members', 'Profile', 'Security', 'Activity'] as const;
const card = 'rounded-3xl border border-border bg-card/60';

const initials = (n: string) =>
  n
    .split(' ')
    .map((x) => x[0])
    .join('');

export function OrganisationSection() {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Members');
  const [members, setMembers] = useState(initialMembers);
  const [invites, setInvites] = useState<string[]>(['alex@acme.example']);
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'All'>('All');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('Developer');
  const [menu, setMenu] = useState<string | null>(null);
  const [profile, setProfile] = useState({
    name: 'Acme Global',
    slug: 'acme-global',
    domain: 'acme.example',
    region: 'EU · Frankfurt',
  });
  const [saved, setSaved] = useState(true);
  const [sec, setSec] = useState({ sso: true, mfa: true, ip: false, byok: true });

  const list = members.filter(
    (m) =>
      (roleFilter === 'All' || m.role === roleFilter) &&
      (m.name + m.email + m.team).toLowerCase().includes(q.toLowerCase()),
  );
  const validEmail = /^\S+@\S+\.\S+$/.test(email);
  const sendInvite = () => {
    if (!validEmail) return;
    setInvites((i) => [...i, email]);
    setEmail('');
    setInviteOpen(false);
  };

  return (
    <div className="space-y-6">
      {/* Profile header */}
      <div className={`${card} relative overflow-hidden p-6`}>
        <div className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full border border-dashed border-border animate-orbit-slow" />
        <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-photon/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-5">
          <div className="relative grid size-16 place-items-center rounded-2xl bg-secondary">
            <Building2 className="size-7 text-photon-glow" />
            <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full bg-primary">
              <Check className="size-3 text-primary-foreground" />
            </span>
          </div>
          <div className="flex-1">
            <h2 className="text-2xl font-semibold">{profile.name}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Globe className="size-3.5" />
                {profile.domain}
              </span>
              <span>{profile.region}</span>
              <span>Member since Mar 2025</span>
            </p>
          </div>
          <div className="flex -space-x-2">
            {members.slice(0, 4).map((m) => (
              <span
                key={m.email}
                title={m.name}
                className="grid size-9 place-items-center rounded-full border-2 border-card bg-secondary text-xs"
              >
                {initials(m.name)}
              </span>
            ))}
            {members.length > 4 && (
              <span className="grid size-9 place-items-center rounded-full border-2 border-card bg-muted text-xs text-muted-foreground">
                +{members.length - 4}
              </span>
            )}
          </div>
        </div>
        <div className="relative mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            ['Plan', 'Enterprise'],
            ['Seats', `${members.length} / 25`],
            ['Tenants', '4 regions'],
            ['Uptime', '99.99%'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-2xl border border-border px-4 py-3">
              <p className="text-[11px] text-muted-foreground">{k}</p>
              <p className="mt-0.5 font-medium">{v}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="liquid-glass inline-flex rounded-full p-1">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`press rounded-full px-4 py-1.5 text-sm transition ${tab === t ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div key={tab} className="animate-rise">
        {tab === 'Members' && (
          <div className={`${card} overflow-visible`}>
            <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
              <div className="flex min-w-56 flex-1 items-center gap-2 rounded-full border border-border px-3 py-1.5">
                <Search className="size-4 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search people or teams"
                  className="flex-1 bg-transparent text-sm outline-none"
                />
              </div>
              <div className="flex rounded-full border border-border p-0.5 text-xs">
                {(['All', ...roles] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRoleFilter(r)}
                    className={`rounded-full px-3 py-1 ${roleFilter === r ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground'}`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setInviteOpen((o) => !o)}
                className="press flex items-center gap-2 rounded-full bg-primary px-4 py-1.5 text-sm text-primary-foreground"
              >
                <UserPlus className="size-4" />
                Invite
              </button>
            </div>

            {inviteOpen && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-photon/5 p-4 animate-rise">
                <Mail className="size-4 text-muted-foreground" />
                <input
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendInvite()}
                  placeholder="name@company.com"
                  className="min-w-48 flex-1 rounded-full border border-border bg-background/40 px-3 py-1.5 text-sm outline-none focus:border-photon"
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Role)}
                  className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
                >
                  {roles
                    .filter((r) => r !== 'Owner')
                    .map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                </select>
                <button
                  disabled={!validEmail}
                  onClick={sendInvite}
                  className="press rounded-full bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
                >
                  Send invite
                </button>
              </div>
            )}

            <div className="hidden grid-cols-[1fr_120px_140px_100px_40px] gap-4 px-5 py-2 text-[11px] text-muted-foreground md:grid">
              <span>Person</span>
              <span>Team</span>
              <span>Role</span>
              <span>Active</span>
              <span />
            </div>
            {list.map((m) => (
              <div
                key={m.email}
                className="group grid grid-cols-[1fr_auto] items-center gap-4 border-t border-border px-5 py-3 text-sm transition hover:bg-foreground/5 md:grid-cols-[1fr_120px_140px_100px_40px]"
              >
                <span className="flex items-center gap-3">
                  <span className="relative grid size-9 place-items-center rounded-full bg-secondary text-xs">
                    {initials(m.name)}
                    {m.online && (
                      <span className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-card bg-hot" />
                    )}
                  </span>
                  <span>
                    {m.name}
                    <span className="block text-xs text-muted-foreground">{m.email}</span>
                  </span>
                </span>
                <span className="hidden text-muted-foreground md:block">{m.team}</span>
                <select
                  value={m.role}
                  disabled={m.role === 'Owner'}
                  onChange={(e) =>
                    setMembers((ms) =>
                      ms.map((x) =>
                        x.email === m.email ? { ...x, role: e.target.value as Role } : x,
                      ),
                    )
                  }
                  className="hidden rounded-full border border-border bg-transparent px-3 py-1 text-xs disabled:opacity-60 md:block"
                >
                  {roles.map((r) => (
                    <option key={r} className="bg-background">
                      {r}
                    </option>
                  ))}
                </select>
                <span className="hidden font-mono text-xs text-muted-foreground md:block">
                  {m.active}
                </span>
                <div className="relative">
                  <button
                    onClick={() => setMenu(menu === m.email ? null : m.email)}
                    aria-label="More"
                    className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                  {menu === m.email && (
                    <div className="liquid-glass absolute right-0 top-9 z-20 w-40 rounded-2xl p-1 text-sm animate-rise">
                      <button
                        onClick={() => setMenu(null)}
                        className="w-full rounded-xl px-3 py-2 text-left hover:bg-foreground/10"
                      >
                        View activity
                      </button>
                      <button
                        disabled={m.role === 'Owner'}
                        onClick={() => {
                          setMembers((ms) => ms.filter((x) => x.email !== m.email));
                          setMenu(null);
                        }}
                        className="w-full rounded-xl px-3 py-2 text-left text-destructive hover:bg-destructive/10 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {list.length === 0 && (
              <p className="border-t border-border p-8 text-center text-sm text-muted-foreground">
                No one matches that search.
              </p>
            )}
            {invites.length > 0 && (
              <div className="border-t border-border p-4">
                <p className="mb-2 text-[11px] text-muted-foreground">Pending invites</p>
                <div className="flex flex-wrap gap-2">
                  {invites.map((i) => (
                    <span
                      key={i}
                      className="flex items-center gap-2 rounded-full border border-dashed border-border py-1 pl-3 pr-1 text-xs"
                    >
                      {i}
                      <button
                        onClick={() => setInvites((x) => x.filter((y) => y !== i))}
                        aria-label="Cancel invite"
                        className="grid size-5 place-items-center rounded-full hover:bg-foreground/10"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'Profile' && (
          <div className={`${card} max-w-2xl p-6`}>
            {(
              [
                ['name', 'Organisation name'],
                ['slug', 'URL'],
                ['domain', 'Verified domain'],
                ['region', 'Data region'],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="mb-4 block">
                <span className="text-xs text-muted-foreground">{l}</span>
                <div className="mt-1 flex items-center rounded-xl border border-border bg-background/40 px-3 focus-within:border-photon">
                  {k === 'slug' && (
                    <span className="text-sm text-muted-foreground">oort.cloud/</span>
                  )}
                  <input
                    value={profile[k]}
                    disabled={k === 'region'}
                    onChange={(e) => {
                      setProfile({ ...profile, [k]: e.target.value });
                      setSaved(false);
                    }}
                    className="flex-1 bg-transparent py-2 text-sm outline-none disabled:text-muted-foreground"
                  />
                  {k === 'domain' && <ShieldCheck className="size-4 text-hot" />}
                </div>
                {k === 'region' && (
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    Memories never leave this region. Contact us to add another.
                  </span>
                )}
              </label>
            ))}
            <div className="flex items-center justify-end gap-3">
              {!saved && (
                <button
                  onClick={() => {
                    setProfile({
                      name: 'Acme Global',
                      slug: 'acme-global',
                      domain: 'acme.example',
                      region: 'EU · Frankfurt',
                    });
                    setSaved(true);
                  }}
                  className="text-sm text-muted-foreground"
                >
                  Discard
                </button>
              )}
              <button
                disabled={saved}
                onClick={() => setSaved(true)}
                className="press rounded-full bg-primary px-5 py-2 text-sm text-primary-foreground disabled:opacity-50"
              >
                {saved ? 'Saved' : 'Save changes'}
              </button>
            </div>
          </div>
        )}

        {tab === 'Security' && (
          <div className="grid gap-4 md:grid-cols-2">
            {(
              [
                ['sso', 'Single sign-on', 'Everyone signs in through Okta.'],
                ['mfa', 'Two-step sign-in', 'Required for every member.'],
                ['ip', 'Office network only', 'Block sign-ins from outside your offices.'],
                ['byok', 'Your own keys', 'Memories are locked with keys you control.'],
              ] as const
            ).map(([k, t, d]) => (
              <button
                key={k}
                onClick={() => setSec((s) => ({ ...s, [k]: !s[k] }))}
                className={`${card} press flex items-start gap-4 p-5 text-left transition hover:border-foreground/20`}
              >
                <span className="flex-1">
                  <span className="block font-medium">{t}</span>
                  <span className="text-sm text-muted-foreground">{d}</span>
                </span>
                <span
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${sec[k] ? 'bg-primary' : 'bg-secondary'}`}
                >
                  <span
                    className={`absolute top-0.5 size-5 rounded-full bg-foreground transition-all ${sec[k] ? 'left-[22px]' : 'left-0.5'}`}
                  />
                </span>
              </button>
            ))}
          </div>
        )}

        {tab === 'Activity' && (
          <div className={`${card} p-6`}>
            <ol className="relative space-y-5 border-l border-border pl-6">
              {[
                ['Jonas Weber', 'rotated the EU encryption key', '12m ago'],
                ['Maya Chen', 'invited alex@acme.example', '2h ago'],
                ['Priya Nair', 'created tenant Support agent', 'Yesterday'],
                ['System', 'moved 1.2M memories to Oort Cloud', '2d ago'],
                ['Maya Chen', 'turned on two-step sign-in', '1w ago'],
              ].map(([w, a, t], i) => (
                <li key={i} className="relative text-sm">
                  <span className="absolute -left-[29px] top-1.5 size-2.5 rounded-full bg-photon-glow ring-4 ring-card" />
                  <span className="font-medium">{w}</span>{' '}
                  <span className="text-muted-foreground">{a}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground">{t}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
