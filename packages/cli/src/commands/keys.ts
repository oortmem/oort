import { PROVIDERS, PROVIDER_ENV, isProvider, type Provider } from '../keychain.js';
import { uiFor } from '../ui.js';
import { Refusal, echo, shown, type Ctx } from '../util.js';
import { clientFor } from './cloud.js';

function providerArg(arg: string, ctx: Ctx): Provider {
  if (!isProvider(arg)) {
    // The argument is not echoed: someone may have pasted a key here.
    throw new Refusal(`unknown provider; expected one of ${PROVIDERS.join(', ')}.`);
  }
  if (ctx.io.env['OORT_NO_KEYCHAIN'] === '1') {
    throw new Refusal('OORT_NO_KEYCHAIN=1 is set; unset it to use stored keys.');
  }
  if (!ctx.keychain.supported) {
    throw new Refusal(
      'this system has no place to keep keys (the Keychain is macOS, credentials.json is Linux and Windows); export the key as an environment variable instead.',
    );
  }
  return arg;
}

/**
 * `oort keys set <provider>`: the value is prompted for with the input hidden (by `security` on
 * macOS, by us for credentials.json), so it never touches argv or the terminal history.
 */
export async function keysSetCommand(arg: string, ctx: Ctx): Promise<number> {
  const provider = providerArg(arg, ctx);
  const code = await ctx.keychain.set(provider);
  if (code === 0) {
    ctx.io.out(
      ctx.keychain.kind === 'file'
        ? `Stored ${provider} in ${ctx.keychain.where(provider)} (mode 600).\n`
        : `Stored ${provider} in the Keychain (oort.${provider}).\n`,
    );
  }
  return code === 0 ? 0 : 1;
}

/** `oort keys rm <provider>`. */
export async function keysRmCommand(arg: string, ctx: Ctx): Promise<number> {
  const provider = providerArg(arg, ctx);
  const code = await ctx.keychain.remove(provider);
  if (code === 0) ctx.io.out(`Removed ${provider} from ${ctx.keychain.label}.\n`);
  return code === 0 ? 0 : 1;
}

export type KeySource = 'env' | 'keychain' | 'missing';

/** Where `provider`'s key would come from (env first, then the Keychain); never the value. */
export async function keySource(provider: Provider, ctx: Ctx): Promise<KeySource> {
  const fromEnv = ctx.io.env[PROVIDER_ENV[provider]];
  if (fromEnv !== undefined && fromEnv !== '') return 'env';
  return (await ctx.keychain.read(provider)) !== undefined ? 'keychain' : 'missing';
}

/** `oort keys list [--json]`: where each key would come from; presence only, never a value or prefix. */
export async function keysListCommand(opts: { json?: boolean }, ctx: Ctx): Promise<number> {
  const rows: { provider: Provider; envVar: string; source: KeySource }[] = [];
  for (const provider of PROVIDERS) {
    rows.push({ provider, envVar: PROVIDER_ENV[provider], source: await keySource(provider, ctx) });
  }
  if (opts.json === true) {
    ctx.io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  const ui = uiFor(ctx.io);
  const where = (r: (typeof rows)[number]): string =>
    r.source === 'env'
      ? r.envVar
      : r.source === 'keychain'
        ? `oort.${r.provider}`
        : r.provider === 'oort'
          ? 'oort login (Oort Pro)'
          : `oort keys set ${r.provider}`;
  const shown = (s: KeySource): string =>
    (s === 'missing' ? ui.yellow : ui.green)(s.padEnd('keychain'.length));
  ctx.io.out(ui.header('keys list'));
  ctx.io.out(ui.kv(rows.map((r) => [r.provider, `${shown(r.source)}  ${ui.dim(where(r))}`])));
  return 0;
}

const SCOPE_ENTRY = /^(planet|[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}(:(read|share))?)$/;

/** `--scope planet,checkout:read` as the API takes it; refuses what it would refuse anyway. */
export function parseKeyScope(raw: string): string[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (entries.length === 0 || entries.length > 17) {
    throw new Refusal('--scope lists planet and up to 16 Constellations, comma separated.');
  }
  const bad = entries.find((e) => !SCOPE_ENTRY.test(e));
  if (bad !== undefined) {
    throw new Refusal(`--scope entry ${echo(bad)} is not planet or <constellation>[:read|:share].`);
  }
  if (!entries.includes('planet')) {
    throw new Refusal('A key always reads and writes your own Planet: start --scope with planet.');
  }
  return [...new Set(entries)];
}

/**
 * `oort keys create [--name <n>] [--scope planet[,<c>[:read|:share]]…] [--json]`: a new Oort Cloud
 * key for this account, shown once. Without --scope it carries everything the account may do;
 * with it, only the Planet and the Constellations named (`:read` recall only, `:share` recall and
 * share). A narrowed key can only make keys inside its own scope. Oort never stores the key.
 */
export async function keysCreateCommand(
  opts: { name?: string; scope?: string; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const name = opts.name?.trim();
  if (name !== undefined && (name.length < 1 || name.length > 60)) {
    throw new Refusal('--name is 1 to 60 characters.');
  }
  const scope = opts.scope === undefined ? undefined : parseKeyScope(opts.scope);
  const client = await clientFor(ctx);
  const k = await client.createKey({
    ...(name !== undefined && { name }),
    ...(scope !== undefined && { scope }),
  });
  if (opts.json === true) {
    ctx.io.out(`${JSON.stringify(k, null, 2)}\n`);
    return 0;
  }
  const ui = uiFor(ctx.io);
  ctx.io.out(
    `${shown(k.key)}\n\n` +
      ui.kv([
        ['name', shown(k.name)],
        ['prefix', shown(k.prefix)],
        ['scope', k.scope === null ? 'everything this account may do' : shown(k.scope.join(', '))],
      ]) +
      ui.dim(
        'This is the only time the key is shown. Keep it like a password; revoke it at oortcloud.dev/account.',
      ) +
      '\n',
  );
  return 0;
}
