# The `oort` command line

Reference for every `oort` command. The guides on the site link here for exact
flags, file paths and output. `oort <command> --help` prints the same flags.

Memories stay on your machine, in `~/.oort` (or `$OORT_HOME`).

## Start here

```sh
pnpm build && cd packages/cli && pnpm add -g .   # from the oort repo, until the package is published
oort setup
```

`oort setup` walks through six steps: it detects your agents, chooses keys,
connects the agents, offers an import, runs a quick check, and lists what
changed and how to undo it. Every step can be skipped.

The connect step writes the realpath of the installed `oort` bin into agent
config files. A copy in a temporary package cache (`npx`, `pnpm dlx`) or a temp
directory is refused, because that path disappears once the run ends. Install
the CLI first.

## Conventions

**Output.** A human-facing command prints one header line, then aligned
key/value rows or a table:

```
oort stats · project oort-1a2b3c4d
scope     oort-1a2b3c4d (+ global memories)
tiers     hot 8, warm 40, cold 0
...
```

Tier names are coloured: hot is cyan, warm is yellow and cold is blue. Where a
row shows a tier with its glyph, the glyphs are `●` hot, `◐` warm and `○` cold.
A one-line confirmation (`pin`, `forget`, `project link`, `keys set`) is its
own header.

**Colour.** Colour is on when stdout is a terminal. `NO_COLOR` (set and
non-empty) turns it off and wins over everything else. `FORCE_COLOR=1` turns it
on for a pipe, `FORCE_COLOR=0` turns it off, and `TERM=dumb` turns it off.

**`--json`.** These commands print data rather than a report: `recall`,
`explain`, `inspect`, `stats` and `keys list`. With `--json` they print JSON
only: no header and no colour. `export` always prints JSON Lines (see
`docs/export-format.md`). `observe` prints its result as JSON.

**Exit codes.**

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Unexpected error. Only the message is printed; add `--debug` for the stack. |
| `2` | Refusal or usage problem, such as a bad flag, missing keys, a file Oort will not edit, or a non-terminal session that would need a prompt. |

**Never blocks a script.** A command that would ask a question refuses (exit 2)
when stdin is not a terminal, and names the flag to pass instead (`--yes` for
`forget`, `import` and `setup`). `oort hook` always exits 0.

**Secrets.** No command prints a key, not even a prefix. An argument echoed in
an error message is scrubbed and clipped to 24 characters.

## `oort setup`

```sh
oort setup                       # interactive, on a terminal
oort setup --yes --agents claude-code,codex --keys byo --import skip
```

| Flag | Values | Default with `--yes` |
| --- | --- | --- |
| `--yes` | Never ask: every choice comes from the flags. | |
| `--agents <list>` | `detected`, `none`, or a comma list of `claude-code`, `claude-desktop`, `codex`, `cursor`, `gemini`, `vscode`. | `detected` |
| `--keys <mode>` | `byo`, `pro` or `skip`. | `byo` |
| `--import <age>` | `skip`, or an age such as `14d`, `30d`, `12h` or `2w`. | `skip` |
| `--no-demo` | Skip the remember, recall and forget check. | the check runs |

On a terminal, a flag answers its question and the other steps still ask. When
stdin or stdout is not a terminal and `--yes` is missing, setup prompts for
nothing. It exits 2 and prints the flags to pass, with your detected agents
filled in.

The steps:

1. **Detect agents.** An agent counts as installed when its directory exists:
   `~/.claude` (Claude Code), `~/.codex` or `$CODEX_HOME` (Codex), `~/.cursor`
   (Cursor), `~/.gemini` (Gemini CLI), or the directory that holds the Claude
   Desktop or VS Code config file (see the table under `oort connect`).
2. **Choose keys.**
   - **Bring my own keys.** Setup shows where each key comes from (env,
     Keychain or missing) and where to get each missing one:
     - Voyage AI, for embeddings and rerank: https://docs.voyageai.com/docs/api-key-and-installation
     - TypeSafe, for the gate and reconcile decisions: https://typesafe.ai
     - Anthropic, for the memory writer: https://platform.claude.com/settings/keys

     On a macOS terminal it then offers to run `oort keys set <provider>` for
     each missing key. With `--yes` it only prints the commands.
   - **Oort Pro (coming in this release).** For now this says that
     `oort login` lands shortly, and setup continues without keys.
   - **Skip.** Recall works lexical-only until keys are set.
3. **Connect.** Claude Code gets the hooks (`oort install claude-code`). Every
   other agent gets the MCP entry (`oort connect <host>`). On a terminal, setup
   first shows the dry-run diff for every agent and asks once before writing
   any of them. An agent whose file Oort will not edit (invalid JSON, or an
   `oort` entry you wrote yourself) is reported and skipped, and the others
   still connect.
4. **Import.** This step appears only when `~/.claude/projects` exists. It
   runs `oort import claude-code --since <age>`: it prints the estimate (the
   sessions, the observations and the approximate writer tokens), then asks
   before it uses the writer. With `--yes --import 14d` the flag is the
   consent.
5. **Check it works.** Setup remembers the harmless fact "The Oort setup demo
   word is nebula." in a throwaway scope (`oort-setup-demo-<random>`), recalls
   it, then forgets everything in that scope. With all three keys the fact goes
   through the normal write path, which costs one writer call. Without them it
   is written straight to the store, so recall and forget still show.
6. **Done.** Setup lists every change with its undo command:

| Change | Undo |
| --- | --- |
| Claude Code hooks in `~/.claude/settings.json` | `oort uninstall claude-code` |
| An MCP entry in a host's config | `oort disconnect <host>` |
| A key in the Keychain | `oort keys rm <provider>` |
| Imported sessions | review with `oort inspect`, remove with `oort forget <id>` |
| A new store in `~/.oort` | `rm -r ~/.oort` (deletes every memory) |

Ctrl-C at a question cancels the rest. Setup then prints what had already
changed, with each undo command, and exits 1.

## `oort connect <host...>` / `oort disconnect <host...>`

```sh
oort connect cursor codex
oort connect vscode --dry-run      # print the diff, write nothing
oort disconnect cursor
```

These commands add or remove one MCP server entry named `oort` in each host's
user-level config. The entry runs the installed bin, with `args` set to
`["mcp"]`.

| Host | File (macOS; Linux and Windows below) | Key | Entry |
| --- | --- | --- | --- |
| `claude-code` | `~/.claude.json` (user scope) | `mcpServers.oort` | `{"type":"stdio","command":"<bin>","args":["mcp"]}` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.oort` | `{"command":"<bin>","args":["mcp"]}` |
| `codex` | `~/.codex/config.toml`, or `$CODEX_HOME/config.toml` | `[mcp_servers.oort]` | `command = "<bin>"`, `args = ["mcp"]` |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers.oort` | `{"type":"stdio","command":"<bin>","args":["mcp"]}` |
| `gemini` | `~/.gemini/settings.json` | `mcpServers.oort` | `{"command":"<bin>","args":["mcp"]}` |
| `vscode` | `~/Library/Application Support/Code/User/mcp.json` | `servers.oort` | `{"type":"stdio","command":"<bin>","args":["mcp"]}` |

Paths on the other platforms:
- **Claude Desktop.** `%APPDATA%\Claude\claude_desktop_config.json` on
  Windows, and `~/.config/Claude/claude_desktop_config.json` on Linux.
- **VS Code.** `%APPDATA%\Code\User\mcp.json` on Windows, and
  `~/.config/Code/User/mcp.json` on Linux. This is the default profile. A
  named profile keeps its own `mcp.json` under `User/profiles/<id>/`, which
  `oort connect` does not edit. Use "MCP: Open User Configuration" in that
  profile and paste the entry.

Sources, read on 2026-11-04:
- Claude Code: https://code.claude.com/docs/en/mcp (scopes, `~/.claude.json`).
- Claude Desktop: modelcontextprotocol.io "Connect to local MCP servers" and
  "Build a server" (all three OS paths).
- Codex: learn.chatgpt.com Codex MCP and config docs (`[mcp_servers.<name>]`,
  `CODEX_HOME`).
- Cursor: https://cursor.com/docs/mcp (`~/.cursor/mcp.json`; `type` is
  required for stdio).
- Gemini CLI: `google-gemini/gemini-cli` `docs/tools/mcp-server.md`.
- VS Code: the `microsoft/vscode-docs` MCP configuration reference and the
  settings file locations.

What every run does:
- **Back up.** The first change to a file copies it to `<file>.oort-backup`.
  That copy is the file as it was before Oort ever changed it, and it is
  never overwritten. Every change also copies the file to `<file>.oort-prev`,
  the state just before that change. Both copies are 0600.
- **Print the diff.** The diff lists keys only, as `+ mcpServers.oort.command`
  for an addition, `~` for a change and `-` for a removal. It never shows a
  value, so another server's token cannot leak into the output.
- **Idempotent.** Running it again changes nothing and says "already
  connected".
- **Keep the rest.** Only the text of the `oort` entry changes. In JSON files,
  comments, key order and the formatting of every other entry are kept, and
  the result is re-parsed to prove that nothing else changed. In Codex TOML,
  the `[mcp_servers.oort]` block is replaced as text and the result is
  re-parsed with a TOML library to prove that the other tables are unchanged.
  A symlinked config (from a dotfiles repo) stays a symlink: its target is
  written. A file's mode is kept, and a new file is created 0600.
- **Never take over your entry.** Oort changes an `oort` entry only if it
  wrote that entry itself, from this install path or an older one. Anything
  else named `oort`, such as a remote URL or extra args, is yours. `connect`
  and `disconnect` then refuse (exit 2) and leave the file untouched. So do an
  unparseable file and a Codex `oort` entry written as an inline table.
- **Disconnect needs no bin.** `disconnect` also removes an entry left by an
  older install path, so it works even from a temporary copy.

After connecting, restart the host. Claude Code and Gemini CLI list servers
with `/mcp`, Codex with `codex mcp list`, Cursor under Settings > MCP, and VS
Code with "MCP: List Servers".

### Scope

The server's memory scope is the project of the directory the host starts it
in, plus global memories:
- **VS Code** starts stdio servers in the workspace folder (documented).
- **Claude Desktop** does not start servers in a project, so its scope is
  usually global.
- **Claude Code, Codex, Gemini CLI and Cursor** start the server in a
  directory they choose, usually your project.

To pin one project, add it to `args`:

```json
"args": ["mcp", "--project", "/path/to/repo"]
```

An entry edited this way counts as yours from then on: `oort connect` and
`oort disconnect` leave it alone.

### Any other MCP client

Any client that starts stdio servers can run Oort. Give it the absolute path
of the bin (`readlink -f "$(command -v oort)"`, or `realpath` on macOS) and
the argument `mcp`:

```json
{ "mcpServers": { "oort": { "command": "/abs/path/to/oort/dist/main.js", "args": ["mcp"] } } }
```

ChatGPT and claude.ai on the web or mobile need a remote MCP URL. That comes
with Oort Cloud, so they are not hosts here.

## `oort mcp`

```sh
oort mcp [--project <dir>]
```

`oort mcp` is a local MCP server on stdin and stdout, built on the official
TypeScript SDK (v2, `@modelcontextprotocol/server`). Hosts start it; you do
not run it by hand. If you do run it on a terminal, it says so on stderr and
keeps serving.
- **Protocol.** It answers both eras that the SDK serves over stdio: the
  `initialize` handshake (2025-11-25 and earlier) and the stateless
  2026-07-28 revision with `server/discover`.
- **Output.** stdout carries only MCP messages. Warnings go to stderr, for
  example an untrusted `project.id`.
- **Scope.** The scope is fixed when the server starts. It comes from the
  start directory, or from `--project <dir>`, and resolves through the same
  trust rules as every other command:
  - a linked project id (`oort project link`) is honoured;
  - a `project.id` in a repository's `oort.config.json` is ignored until you
    link it;
  - a directory outside any repository is global.

  No tool argument can choose another scope. An id from another project is
  "not found", exactly like a missing one.

Tools:

| Tool | Input | Annotations | Returns |
| --- | --- | --- | --- |
| `recall` | `query` (1–500 chars), `as_of?` (ISO date or date-time), `limit?` (1–10, default 5) | read-only, idempotent | current facts: `id`, `text`, `type`, `tier`, `valid_from`, `why` (for example `lexical #1, dense #2, rerank 0.91`); a `note` when recall is lexical-only |
| `remember` | `facts` (1–5 strings, each one line of 1–500 chars), `type?` (a hint: `semantic`, `episodic`, `procedural`, `preference`) | write, not destructive, not idempotent | per fact: `outcome` (`added`, `reinforced`, `updated`, `superseded` or `skipped`), `id`, `supersedes`, `reason` (`secret`, `not durable`) |
| `forget` | `id` (required) | destructive, idempotent | `{ forgotten: id }` |
| `pin` | `id`, `pinned` (boolean) | write, not destructive, idempotent | `{ id, pinned, changed }` |
| `explain` | `id` | read-only, idempotent | the memory, its stored decisions, and its supersede chain |
| `list_recent` | `since?` (ISO), `limit?` (1–50, default 20) | read-only, idempotent | memories by `updated_at`, newest first, each with `status` (`current`, `superseded` or `expired`) |
| `whoami` | none | read-only, idempotent | `mode: "local"`, `project`, `version`, which adapters are available; no account or email |

Every tool sets `openWorldHint: false` and has a `title`.

`remember` runs each fact through the normal write path, exactly as
`oort observe` builds a turn: a user turn "Remember this: <fact>" and an
assistant turn "Noted: <fact>". The path is scrub, gate, reconcile and the
writer. Secrets are therefore scrubbed, and a fact that is only a secret is
skipped. A duplicate fact reinforces the existing memory, and a contradicting
one supersedes it; the old fact is kept with its validity closed. The tool
needs all three keys. Without them it returns an error that names
`oort keys set`, and `recall` keeps working, lexical-only.

The server instructions:

> Oort is the user's own long-term memory, which they connected on purpose. `recall` searches facts the user chose to keep from earlier sessions: decisions, preferences, project details. Use it when the user refers to earlier work, or when their past context would change the answer; skip it for self-contained questions. Use `remember` only for durable facts the user stated or confirmed, one standalone sentence each, never secrets or credentials. `forget` deletes permanently.

The first paragraph above stands alone in under 512 characters. A second
paragraph covers scope, `as_of`, supersession, batching facts and ids.

The server is wired once at start-up. A key you set while it runs is picked
up the next time the host restarts it.

## Claude Code hooks: `oort install` / `oort uninstall`

```sh
oort install claude-code [--project]
oort uninstall claude-code [--project]
```

These commands add or remove the `UserPromptSubmit`, `Stop` and
`SessionStart` hooks in `~/.claude/settings.json`, or in
`<cwd>/.claude/settings.json` with `--project`. The hooks run
`<bin> hook <event>`. The first change keeps a one-time backup at
`settings.json.oort-backup`. Only exact Oort entries are touched; a wrapper
such as `cd x && oort hook Stop` is left alone. See `docs/claude-code.md`.

`oort connect claude-code` is separate. It adds the MCP server to
`~/.claude.json`, so the tools are available too.

## Memory commands

| Command | What it does | Flags |
| --- | --- | --- |
| `oort recall <text>` | Recalls memories as they would be injected into the prompt (an `<oort-memory>` block). | `--json` (the full RecallResult, without embeddings), `--as-of <iso>` |
| `oort explain <query>` | Runs the same recall and shows each stage's rank and score per memory: lexical, dense, RRF, fused, reranked, activation and hydrated. | `--json` (rank, id, type, tier, validFrom, text, explanation; timings; degraded) |
| `oort inspect [id]` | Lists current memories, or shows one in full with its decisions and supersede chain. | `--json`, `--limit <n>` (default 50) |
| `oort stats` | Counts per tier and validity, store and cold sizes, the hook queue and memory use. | `--json` |
| `oort observe` | Runs the write path on one turn, from JSON on stdin or from `--user` with `--assistant`. | `--dry-run` (reports scrubbing only) |
| `oort forget <id>` | Deletes a memory everywhere. It asks first on a terminal. | `--yes` |
| `oort pin <id>` / `oort unpin <id>` | A pinned memory is never sent to cold storage. | |
| `oort consolidate` | Expires, re-tiers and evicts memories. | |
| `oort export` | Writes every visible memory as v1 JSON Lines. | `--out <file>` (0600), `--force` |
| `oort import claude-code` | Imports Claude Code transcripts. It prints the estimate first, then asks. | `--since <age>`, `--yes`, `--estimate-only`, `--include-unresolved`, `--projects-dir <dir>` |

Ids are full ids or unique prefixes. Every command reads the cwd's project
plus global memories.

## Keys: `oort keys`

```sh
oort keys set voyage      # macOS Keychain prompts for the value, hidden
oort keys list [--json]   # where each key comes from: env, keychain or missing
oort keys rm voyage
```

The providers are `voyage` (`VOYAGE_API_KEY`), `typesafe`
(`TYPESAFE_API_KEY`) and `anthropic` (`ANTHROPIC_API_KEY`). A set, non-empty
environment variable wins over the Keychain. `keys list` prints where each key
comes from; with `--json` it prints
`[{ "provider", "envVar", "source" }]`. It never prints a value.

`OORT_NO_KEYCHAIN=1` switches the Keychain off for every command: nothing runs
`/usr/bin/security`, and `keys set` and `keys rm` refuse while it is set. See
`docs/claude-code.md` for why `ANTHROPIC_API_KEY` should stay out of your
shell profile.

## Projects: `oort project`

```sh
oort project link [--id <id>]   # trust this repository's project id
oort project unlink
```

A repository's `oort.config.json` can name a `project.id`. That id is ignored
until you link it, because a cloned repository could otherwise read another
project's memories. See `docs/claude-code.md`.

## Other commands

- `oort init [--project]` writes `~/.oort/config.json` with the defaults, and
  never overwrites it. With `--project` it also writes `oort.config.json` at
  the git root. It then reports which keys are missing.
- `oort hook <event>` is what the Claude Code hooks run. It reads the hook
  JSON on stdin and always exits 0.

## Planned (not in this build)

- `oort login` / `oort logout`: sign in to Oort Pro at oortcloud.dev and store
  the Oort key in the Keychain as `oort.oort`.
- `oort doctor`: checks keys (presence only), hooks, connectors, store health
  and relay reachability, with a fix for each failure.
- ChatGPT and claude.ai web or mobile: need the remote MCP URL that comes with
  Oort Cloud.
