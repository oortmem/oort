# Using Oort with Claude Code

## Provider keys

Oort reads three provider keys. For each, an environment variable wins when it
is set and non-empty; otherwise Oort reads the macOS Keychain.

| Provider    | Environment variable | Keychain item      | Used for              |
| ----------- | -------------------- | ------------------ | --------------------- |
| `voyage`    | `VOYAGE_API_KEY`     | `oort.voyage`      | embed and rerank      |
| `typesafe`  | `TYPESAFE_API_KEY`   | `oort.typesafe`    | decide                |
| `anthropic` | `ANTHROPIC_API_KEY`  | `oort.anthropic`   | write                 |

The Keychain is the recommended place (macOS only for now; Linux and Windows
are tracked in CON-55):

```sh
oort keys set voyage      # the Keychain prompts for the value (hidden input)
oort keys list            # voyage: keychain / env / missing; never a value
oort keys rm voyage
```

`oort keys set` runs `/usr/bin/security add-generic-password` with `-w` as the
last argument, so `security` asks for the key itself: it never appears in
argv, in Oort's process or in shell history. Items are stored under the
service `oort.<provider>` and your OS username.

### Do not export `ANTHROPIC_API_KEY` globally

Claude Code reads `ANTHROPIC_API_KEY` too. If you use Claude Code on a
subscription and export that variable in your shell profile, Claude Code
bills the API instead of the subscription. Store the key with
`oort keys set anthropic` instead, and leave the variable unset. Export it
only for a single command when you need to: `ANTHROPIC_API_KEY=... oort observe ...`.

Set `OORT_NO_KEYCHAIN=1` to make Oort ignore the Keychain entirely.
