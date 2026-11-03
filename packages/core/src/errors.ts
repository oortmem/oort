/** Thrown at construction time when a required credential is absent. */
export class MissingCredentialError extends Error {
  readonly envVar: string;
  readonly configKey: string;

  constructor(envVar: string, configKey: string) {
    super(
      `Missing ${envVar}. Set it with: export ${envVar}=... (or set ${configKey} in ~/.oort/config.json).`,
    );
    this.name = 'MissingCredentialError';
    this.envVar = envVar;
    this.configKey = configKey;
  }
}
