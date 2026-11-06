# Hooks, MCP, SDK or CLI

All four run the same engine over the same memory. Pick by who decides when memory is read and
written, and whether you write code.

## One store underneath

- In local mode everything reads and writes one home: `~/.oort`, or `$OORT_HOME`. In cloud mode
  (after `oort cloud use`, or `createOort({ mode: 'cloud' })`) it is the Oort Cloud account of
  the Oort key. `createOort()` with the default `mode: 'auto'` follows what `oort setup` chose.
- What the hooks saved, the SDK and the MCP server recall, and the other way round, as long as
  they act as the person. Memories written through an SDK handle with a `user` (an end user of
  your app) are invisible to `oort recall`.
- The CLI acts as the agent `--agent`, `OORT_AGENT`, else `claude-code`. The SDK acts as
  `agent`, `OORT_AGENT`, else anonymous (the Planet only, no Star).

## The hooks: memory for the user's own Claude Code sessions

Nothing to code. Before each prompt the `UserPromptSubmit` hook recalls and injects an
`<oort-memory>` block; the `Stop` hook saves the turn; `SessionStart` injects pinned and hot
memories. Use one of these, never both (both would recall twice on every prompt):

```sh
npm install -g oortmem
oort setup                      # keys or Oort Pro, then connects the agents it finds
# or only the hooks:
oort install claude-code
```

```sh
claude plugin marketplace add oortmem/oort
claude plugin install oort@oortmem      # hooks, the `oort` MCP server and the oort-memory skill
```

Run `oort uninstall claude-code` before installing the plugin if the hooks were installed with
the CLI. The Codex plugin (`oort@oortmem` in Codex) adds the `UserPromptSubmit` and
`SessionStart` hooks; Codex saves through the `remember` tool.

## The MCP server: the model decides when to recall

`oort mcp` is a stdio MCP server. Hosts start it; `oort connect <host>` writes each host's config
(`claude-code`, `claude-desktop`, `codex`, `cursor`, `gemini`, `vscode`) as `oort mcp --agent
<host>`, backs up the old file and prints the diff.

```sh
oort connect cursor codex
oort mcp --agent my-client --project /path/to/repo   # what any other stdio MCP client runs
```

- Tools: `recall`, `remember`, `forget`, `pin`, `explain`, `list_recent` and `whoami`; the local
  server adds `record_judgment` and `judge`. The scope is fixed when the server starts: no tool
  argument can choose another project, agent or user.
- Any MCP-capable agent framework can run `oort mcp` with no code at all. Use the SDK instead when
  your code, not the model, should decide when to recall and save, or when you serve more than
  one end user.

## The SDK: memory inside your own code

```sh
npm i oortmem
```

`import { createOort, formatForPrompt } from 'oortmem'`, plus `oortmem/ai-sdk` for the Vercel AI
SDK. ESM only (`require('oortmem')` works through Node's `require(esm)`), Node.js 22.15 or newer.
The root export never loads the CLI, and cloud mode loads no native module. `@oortmem/core` has no
stability promise: apps import `oortmem`. See [sdk.md](sdk.md).

## The CLI: scripts, CI and other languages

Every command except `oort hook`, `oort mcp` and a foreground `oort serve` takes `--json` (or
`OORT_OUTPUT=json`) and prints one `oort.v1` envelope on stdout. That is the contract for
Python today and for any other language. See [cli-and-python.md](cli-and-python.md).

## Not in 0.6.3

- A native Python client (`from oortmem import Oort`) arrives in 0.7. Today the PyPI package
  `oortmem` is a launcher for the `oort` command and still needs Node.js 22.15 or newer.
- A `remote` SDK mode against `oort serve` arrives in 0.7. `oort serve` today is a daemon that
  makes the Claude Code hooks faster; it is not an API for your app.
- Per-user agent memory (a Star per end user) and `user` in cloud mode come with CON-92.
- `place`, `near` and `within` are reserved for spatial memory: passing them is a usage error.
