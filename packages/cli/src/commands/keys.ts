import { PROVIDERS, PROVIDER_ENV, isProvider, type Provider } from '../keychain.js';
import { Refusal, type Ctx } from '../util.js';

function providerArg(arg: string, ctx: Ctx): Provider {
  if (!isProvider(arg)) {
    // The argument is not echoed: someone may have pasted a key here.
    throw new Refusal(`unknown provider; expected one of ${PROVIDERS.join(', ')}.`);
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

/** `oort keys list`: where each key would come from; presence only, never a value or prefix. */
export async function keysListCommand(ctx: Ctx): Promise<number> {
  for (const provider of PROVIDERS) {
    const fromEnv = ctx.io.env[PROVIDER_ENV[provider]];
    let source = 'missing';
    if (fromEnv !== undefined && fromEnv !== '') source = 'env';
    else if ((await ctx.keychain.read(provider)) !== undefined) source = 'keychain';
    ctx.io.out(`${provider}: ${source}\n`);
  }
  return 0;
}
