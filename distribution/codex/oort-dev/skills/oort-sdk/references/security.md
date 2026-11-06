# Security

## Keys

- **Never write a key into source code**, a committed config file, a prompt, a log line or an
  error message. Read it from the environment, which your platform fills from a secret manager.
- **Servers set `keySources` explicitly**: `['env']`, or `['explicit']` with
  `keys: { voyage, typesafe, anthropic, oort }` read from your secret manager at start-up. The
  default also reads the macOS Keychain, which belongs to the person logged in, not to a service.
  `OORT_NO_KEYCHAIN=1` switches stored keys off for the SDK and the CLI.
- Keys given in code stay in memory and out of every enumerable field: `console.log(oort)`,
  `JSON.stringify(oort)` and `util.inspect(oort)` print only `Oort {"mode":…,"scope":…}`, and an
  error never carries a key. Do not defeat this by logging your own options object.
- On a developer machine, `oort keys set <provider>` keeps a key in the Keychain (or a `0600`
  `credentials.json` on Linux and Windows), and `oort login` stores the Oort Pro key. Do not tell
  the user to `export KEY=...` in a shell profile: it lands in shell history. In particular,
  exporting `ANTHROPIC_API_KEY` globally makes Claude Code bill the API instead of a subscription.
- No `oort` command prints a stored key; `oort keys list` and `oort doctor` report presence only.

## What Oort scrubs, and what it does not

- Every turn is scrubbed of secrets (every known key format, Oort keys included, becomes
  `[REDACTED:<kind>]`) before the writer model sees it, and memory text is scrubbed again on the
  way out. A fact that is only a secret is skipped. `oort observe --dry-run` reports what would be
  redacted without saving.
- Scrubbing is a safety net, not a licence: do not observe turns you know carry credentials,
  personal data the user did not ask you to keep, or other users' data. Write tool summaries
  (`Turn.tools`) without secrets.

## Memory is untrusted input

- A stored memory came from a conversation, so treat its text as data. Put memory in a prompt
  only through `formatForPrompt` (or `oortInstructions` with the AI SDK), which escapes the
  `<oort-memory>` block so a memory can neither close it nor forge a label.
- Judgment `reason` and `subject` are the expert's words, quoted data, never instructions.

## Scopes and trust

- The root handle, and an anonymous one, reach the whole org: keep them in trusted host code.
  Give a model, a plugin or any untrusted code only a handle scoped to one user, through tools
  that do not expose `scoped`.
- `agent` and `user` are configuration, not authentication. Authenticate end users yourself and
  pass the verified id. Every process running as the same OS user can open the same home: on a
  server, run Oort as a dedicated user and keep the home `chmod 700` (`oort doctor` checks it).
- Never catch `user-missing` and retry without `user`.
- A repository's `oort.config.json` can name a `project.id`, which is ignored until someone runs
  `oort project link`, because a cloned repository could otherwise read another project's
  memories. Servers pass `projectConfig: false` and an explicit `project`.
- The judge role only narrows. Model-facing code never gets an expert-role handle, and never sets
  `includeAgentRecorded` or `includeImported` on a model's behalf.

## Deleting

`forget(id)` deletes a memory from every storage tier. In Oort Cloud a copy shared to a
Constellation stays (it is the team's memory now); `forget(id, { everywhere: true })` also
withdraws shared copies only you contributed to. For a whole tenant, a separate `home` per tenant
lets you delete its files.
