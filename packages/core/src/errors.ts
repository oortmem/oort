/** Env var to the `oort keys` provider that can supply it. */
const KEYCHAIN_PROVIDERS: Record<string, string> = {
  VOYAGE_API_KEY: 'voyage',
  TYPESAFE_API_KEY: 'typesafe',
  ANTHROPIC_API_KEY: 'anthropic',
};

/**
 * Thrown at construction time when a required credential is absent. The
 * message names only the environment variable: keys are never read from the
 * plaintext config file. `configKey` names the adapter's config section
 * (e.g. `embed.apiKey`) for callers that group failures; it is not shown.
 */
export class MissingCredentialError extends Error {
  readonly envVar: string;
  readonly configKey: string;

  constructor(envVar: string, configKey: string) {
    const provider = KEYCHAIN_PROVIDERS[envVar];
    super(
      provider === undefined
        ? `Missing ${envVar}. Set it with: export ${envVar}=...`
        : `Missing ${envVar}. Set it with: oort keys set ${provider} (or export ${envVar}=...)`,
    );
    this.name = 'MissingCredentialError';
    this.envVar = envVar;
    this.configKey = configKey;
  }
}
