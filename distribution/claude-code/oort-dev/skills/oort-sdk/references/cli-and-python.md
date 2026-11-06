# The CLI from scripts and other languages (Python today)

`oortmem` 0.6.1 has no native Python client; that arrives in 0.7. Today, Python (and any other
language) calls the `oort` command with `--json` and reads one `oort.v1` envelope from stdout.
Install the CLI with `npm install -g oortmem`, or `pipx install oortmem` (a launcher that runs the
same npm release and still needs Node.js 22.15 or newer).

## The envelope

Every command except `oort hook`, `oort mcp` and a foreground `oort serve` takes `--json` (or
`OORT_OUTPUT=json` in the environment) and prints exactly one document on stdout; human lines
and warnings go to stderr.

```json
{ "schema": "oort.v1", "command": "recall", "ok": true, "data": { "memories": [] }, "warnings": [] }
```

- `data` is always an object; a list is wrapped (`data.memories`). Field names are camelCase,
  ids are full ids, times are ISO 8601. `oort recall --json` gives the full recall result
  (`memories`, `abstained`, `temporal`, `read`, `degraded`, `timings`).
- `warnings` carry a `code` (`lexical-only`, `recall-degraded`, …) and a `message`.
- On failure: `"ok": false` and `error` with `code` (the same codes as `OortError.code`:
  `usage`, `not-found`, `ambiguous-id`, `needs-key`, `needs-login`, `needs-confirmation`,
  `cloud-only`, `network`, `refused`, `internal`), `message`, `fix` (a runnable command, or
  `null`) and `exitCode`.
- Exit codes: `0` success, `1` an unexpected error, `2` a refusal or usage problem, `3` partial
  success (`oort import claude-code`).
- A command that asks first (`forget`, `import`, …) never asks under `--json`: it fails with
  `needs-confirmation` until you pass `--yes`. Pass `--yes` only after your own code has
  confirmed the action.

## Python

A small wrapper. It needs Python 3.7 or newer and the `oort` command on `PATH`.

<!-- tested: python, by examples/test/skill.test.ts -->

```python
from __future__ import annotations

import json
import subprocess


class OortCliError(Exception):
    """An oort.v1 failure envelope: branch on `code`, show `fix` to the operator."""

    def __init__(self, command: str, error: dict):
        super().__init__(f"oort {command}: {error['code']}: {error['message']}")
        self.code = error["code"]  # usage, not-found, needs-key, needs-login, refused, network, ...
        self.fix = error.get("fix")  # a runnable `oort ...` command, or None
        self.exit_code = error["exitCode"]


def oort(args: list[str], stdin: dict | None = None) -> dict:
    """Runs one `oort` command with --json and returns the envelope's `data`."""
    proc = subprocess.run(
        ["oort", *args],  # a list, never a shell string
        input=None if stdin is None else json.dumps(stdin),
        capture_output=True,  # human lines and warnings go to stderr
        text=True,
    )
    envelope = json.loads(proc.stdout)  # exactly one oort.v1 document
    if not envelope["ok"]:
        raise OortCliError(envelope["command"], envelope["error"])
    return envelope["data"]


def recall(query: str) -> list[dict]:
    # Flags first, then `--`, so a query that starts with "-" is never read as a flag.
    return oort(["recall", "--json", "--", query])["memories"]


def observe(user: str, assistant: str) -> dict:
    # The turn goes on stdin, not in argv, where other processes could read it.
    return oort(["observe", "--json"], stdin={"userText": user, "assistantText": assistant})
```

- `oort observe` reads one turn as JSON on stdin (`userText`, `assistantText`, and optionally
  `toolSummaries`, `sessionId`, `turnRef` and `at`), or from `--user` with `--assistant`. Prefer
  stdin: arguments are visible to other processes on the machine.
- Each call starts a Node process (about 100 ms). For a chat loop that is fine; for bulk work,
  batch, or use the TypeScript SDK in a small Node service.
- The CLI acts as the person (`--agent`, `OORT_AGENT`, else `claude-code`) on the project of its
  working directory: set `cwd=` on `subprocess.run`, or `OORT_HOME` in its `env=`, to choose the
  store. It has no per-end-user scope: a multi-user Python backend should wait for 0.7, or call a
  Node service that uses `scoped({ user })`.
- Keys come from the environment the process inherits (`VOYAGE_API_KEY`, `TYPESAFE_API_KEY`,
  `ANTHROPIC_API_KEY`, `OORT_API_KEY`). On a server set `OORT_NO_KEYCHAIN=1`.

### Memory in a prompt from Python

`recall` returns memory text as data. Before 0.7 there is no `formatForPrompt` in Python, so
never paste `memory["text"]` into a prompt as instructions: keep it in a clearly delimited data
section, escape it for your template, and tell the model it is recalled user data. The plain
`oort recall "<text>"` output (without `--json`) prints a header line and then the escaped
`<oort-memory>` block the hooks inject; that human output is not a stable contract, so prefer
`--json`.

## Other commands worth knowing

| Command                                 | What it does                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `oort recall "<text>" --json`           | Recall as the acting agent; `--as-of`, `--known-at`, `--history`                                               |
| `oort observe --json`                   | Run the write path on one turn (stdin JSON, or `--user` and `--assistant`); `--dry-run` reports scrubbing only |
| `oort forget <id> --yes --json`         | Delete a memory everywhere                                                                                     |
| `oort pin <id>` / `oort unpin <id>`     | Keep a memory out of cold storage, or release it                                                               |
| `oort inspect [id] --json`              | List current memories, or one with its decisions                                                               |
| `oort judge record`, `oort judge apply` | Judgment memory, as in [judgments.md](judgments.md)                                                            |
| `oort whoami --json`                    | Which store, agent and spaces this runs against                                                                |
| `oort doctor --json`                    | Check keys, store, hooks and MCP entries; prints a fix per problem                                             |
