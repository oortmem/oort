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

## Phase 1 baseline (dogfood, 2026-11-04)

First real run on Marcus's machine (Apple Silicon laptop, heavily loaded: load
average 50 to 150 from emulators running at the same time). Keys from the Keychain.

| Measure | Value |
| --- | --- |
| `oort import claude-code --since 14d` | 2 sessions with a resolvable project, 246 observations, 7 sessions skipped (project gone) |
| Import estimate vs reality | ~169k writer tokens estimated; well under $0.10 on Haiku 5.5 |
| Memories written | 48 in one project (8 hot, 40 warm); 15 current, 33 superseded |
| Gate outcome mix (last run) | skipped 21, added 7, updated 10, superseded 6, reinforced 1, unwritable 7 |
| Unwritable | 7 of 52 (13%): writer `text` over 600 chars twice in a row (an exchange holding several facts) |
| `UserPromptSubmit` hook recall | p50 598 ms, max 1,133 ms over 5 prompts (Voyage embed + rerank round trips; empty scope) |
| `oort recall` from the shell | about 1.1 s wall clock including Node start-up |

Fixed during the run: an import stopped a whole session on a deterministic
writer failure and printed no reason (now skipped and reported as
`unwritable`, with the error class and fields); a stub over 200 chars failed
the observation (now cut at a word boundary up to 600 chars).

Open findings:
- The hook's recall latency (~0.6 s) is above the design's 300 ms budget;
  most of it is two network calls. Measure embed vs rerank and consider
  skipping rerank when fusion is confident (pricing note, recommendation 3).
- 13% unwritable: the writer should be able to return more than one memory
  per observation instead of overflowing one.
- The superseded share (69%) is high; check that status updates are not
  superseding unrelated facts.
