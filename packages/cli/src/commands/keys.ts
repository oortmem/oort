import { PROVIDERS, PROVIDER_ENV, isProvider, type Provider } from '../keychain.js';
import { uiFor } from '../ui.js';
import { Refusal, type Ctx } from '../util.js';

function providerArg(arg: string, ctx: Ctx): Provider {
  if (!isProvider(arg)) {
    // The argument is not echoed: someone may have pasted a key here.
    throw new Refusal(`unknown provider; expected one of ${PROVIDERS.join(', ')}.`);
  }
  if (ctx.io.env['OORT_NO_KEYCHAIN'] === '1') {
    throw new Refusal('OORT_NO_KEYCHAIN=1 is set; unset it to use the Keychain.');
  }
  if (!ctx.keychain.supported) {
    throw new Refusal(
      'the Keychain is macOS-only for now (CON-55); export the key as an environment variable instead.',
    );
  }
  return arg;
}

/** `oort keys set <provider>`: `security` prompts for the value, so it never touches argv or us. */
export async function keysSetCommand(arg: string, ctx: Ctx): Promise<number> {
  const provider = providerArg(arg, ctx);
  const code = await ctx.keychain.set(provider);
  if (code === 0) ctx.io.out(`Stored ${provider} in the Keychain (oort.${provider}).\n`);
  return code === 0 ? 0 : 1;
}

/** `oort keys rm <provider>`. */
export async function keysRmCommand(arg: string, ctx: Ctx): Promise<number> {
  const provider = providerArg(arg, ctx);
  const code = await ctx.keychain.remove(provider);
  if (code === 0) ctx.io.out(`Removed ${provider} from the Keychain.\n`);
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
        : `oort keys set ${r.provider}`;
  const shown = (s: KeySource): string =>
    (s === 'missing' ? ui.yellow : ui.green)(s.padEnd('keychain'.length));
  ctx.io.out(ui.header('keys list'));
  ctx.io.out(ui.kv(rows.map((r) => [r.provider, `${shown(r.source)}  ${ui.dim(where(r))}`])));
  return 0;
}
