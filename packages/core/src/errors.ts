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
    super(`Missing ${envVar}. Set it with: export ${envVar}=...`);
    this.name = 'MissingCredentialError';
    this.envVar = envVar;
    this.configKey = configKey;
  }
}
