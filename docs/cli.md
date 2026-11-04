# The `oort` command line

Reference for every `oort` command. The guides on the site link here for exact
flags, file paths and output. `oort <command> --help` prints the same flags.

Memories stay on your machine, in `~/.oort` (or `$OORT_HOME`).

## Start here

```sh
npm i -g oortmem    # installs the `oort` command (and `oortmem`, the same bin)
oort setup
```

Or run `npx oortmem setup`. The npm package is `oortmem`, because `oort` is
taken on npm. It installs two names for the same bin, `oort` and `oortmem`;
the docs use `oort`. From a clone of the repo, use
`pnpm build && cd packages/cli && pnpm add -g .` instead.

`oort setup` walks through six steps: it detects your agents, chooses keys,
connects the agents, offers an import, runs a quick check, and lists what
changed and how to undo it. Every step can be skipped.

The connect step writes the realpath of the installed `oort` bin into agent
config files. A copy in a temporary package cache (`npx`, `pnpm dlx`) or a temp
directory is never written, because that path disappears once the run ends,
and neither is `npx -y oortmem`, which is slow to start and needs the network.
Under `npx oortmem setup`, setup offers to run `npm i -g oortmem` first and
then writes the global install's path (see the connect step below).

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
`explain`, `revalidate`, `inspect`, `stats`, `keys list` and `doctor`. With `--json` they print JSON
only: no header and no colour. `export` always prints JSON Lines (see
`docs/export-format.md`). `observe` prints its result as JSON.

**Exit codes.**

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Unexpected error. Only the message is printed; add `--debug` for the stack. |
| `2` | Refusal or usage problem, such as a bad flag, missing keys, a file Oort will not edit, or a non-terminal session that would need a prompt. |

`oort doctor` exits 1 when one of its checks fails, and `oort login` exits 1
when the sign-in expires, was already used or is cancelled.

**Never blocks a script.** A command that would ask a question refuses (exit 2)
when stdin is not a terminal, and names the flag to pass instead (`--yes` for
`forget`, `import` and `setup`). `oort hook` always exits 0.

**Secrets.** No command prints a key, not even a prefix. An argument echoed in
an error message is scrubbed and clipped to 24 characters.

**Environment.**

| Variable | Effect |
| --- | --- |
| `VOYAGE_API_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY` | Your own vendor keys. Each wins over the stored key (Keychain item or `credentials.json` entry) of the same provider. |
| `OORT_API_KEY` | Your Oort Pro key. It wins over the stored `oort` key (Keychain item `oort.oort`). |
| `OORT_RELAY_URL` | The Oort Pro relay root, for local development against `wrangler dev` (default `https://relay.oortcloud.dev`). https only, or http to `localhost`, `127.0.0.1` or `[::1]`. |
| `OORT_SITE_URL` | The site `oort login` signs in at, for local development (default `https://oortcloud.dev`). The same rule applies. |
| `OORT_NO_KEYCHAIN=1` | Switches stored keys (Keychain and `credentials.json`) off for every command (see `oort keys`). |
| `OORT_HOME` | The store directory (default `~/.oort`). |
| `NO_COLOR`, `FORCE_COLOR` | See Colour above. |

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
| `--install-global` | Under `npx`: run `npm i -g oortmem` before connecting. | no install |

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
   - **Oort Pro.** No vendor keys, $19 a month. Setup runs `oort login`
     right there (see below): the browser sign-in, the code you type on the
     page, and the wait for approval. If the sign-in fails, expires or key storage is off,
     setup says why and carries on without it. `--yes --keys pro` signs in
     without a question: it prints the page and the code, and waits.
   - **Skip.** Recall works lexical-only until keys are set.

   Setup also shows whether an Oort key exists (`OORT_API_KEY` or Keychain
   `oort.oort`). If one does, this step asks nothing: the key already covers
   every role without a vendor key.
3. **Connect.** Claude Code gets the hooks (`oort install claude-code`). Every
   other agent gets the MCP entry (`oort connect <host>`). On a terminal, setup
   first shows the dry-run diff for every agent and asks once before writing
   any of them.

   Under `npx oortmem setup` the running copy is temporary, so setup first
   looks for a global install (`<npm prefix -g>/bin/oort`) and uses its path
   if there is one. Otherwise it asks whether to run `npm i -g oortmem`, or,
   with `--yes`, runs it only with `--install-global`. Without the install it
   skips connecting and says which command to run. The npx path itself is
   never written, and neither is `npx -y oortmem`. An agent whose file Oort will not edit (invalid JSON, or an
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
| A key in the Keychain or `credentials.json` | `oort keys rm <provider>` |
| The Oort Pro key (`oort.oort`, or its `credentials.json` entry) | `oort logout`, then revoke the key at oortcloud.dev/account |
| A global install (`npm i -g oortmem`) | `npm rm -g oortmem` |
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
user-level config. The entry runs the installed bin as `oort mcp`. Cursor and
VS Code also get `--project ${workspaceFolder}`, which they replace with the
open workspace's folder; the other hosts get no arguments beyond `mcp`.

| Host | File (macOS; Linux and Windows below) | Key | Entry |
| --- | --- | --- | --- |
| `claude-code` | `~/.claude.json` (user scope) | `mcpServers.oort` | `{"type":"stdio","command":"<bin>","args":["mcp"]}` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.oort` | `{"command":"<bin>","args":["mcp"]}` |
| `codex` | `~/.codex/config.toml`, or `$CODEX_HOME/config.toml` | `[mcp_servers.oort]` | `command = "<bin>"`, `args = ["mcp"]` |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers.oort` | `{"type":"stdio","command":"<bin>","args":["mcp","--project","${workspaceFolder}"]}` |
| `gemini` | `~/.gemini/settings.json` | `mcpServers.oort` | `{"command":"<bin>","args":["mcp"]}` |
| `vscode` | `~/Library/Application Support/Code/User/mcp.json` | `servers.oort` | `{"type":"stdio","command":"<bin>","args":["mcp","--project","${workspaceFolder}"]}` |

**Claude Code through its CLI.** Claude Code rewrites `~/.claude.json`
itself, so a running Claude Code could overwrite a direct edit. When `claude`
is on `PATH` (macOS and Linux), `oort connect claude-code` therefore runs
`claude mcp add --scope user oort -- <bin> mcp`, and `oort disconnect
claude-code` runs `claude mcp remove --scope user oort`. Oort still reads the
file first: it refuses an `oort` entry it did not write, prints the diff and
makes the backups. A stale entry from an older path is removed, then added
again. Afterwards Oort checks that the file holds the expected entry; the
`env: {}` that `claude` adds counts as the same entry. When `claude` is not on
`PATH`, Oort edits `~/.claude.json` directly, as for the other hosts.

Paths on the other platforms:
- **Claude Desktop.** `%APPDATA%\Claude\claude_desktop_config.json` on
  Windows, and `~/.config/Claude/claude_desktop_config.json` on Linux.
- **VS Code.** `%APPDATA%\Code\User\mcp.json` on Windows, and
  `~/.config/Code/User/mcp.json` on Linux. This is the default profile. A
  named profile keeps its own `mcp.json` under `User/profiles/<id>/`, which
  `oort connect` does not edit, and there is no `--profile` option yet. Use
  "MCP: Open User Configuration" in that profile and paste the entry.

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
  wrote that entry itself, from this install path or an older one (an `oort`
  or `oortmem` bin, a package's `oort/dist/main.js` or `oortmem/dist/main.js`,
  or the `["mcp"]` args that Cursor and VS Code entries had before
  `--project ${workspaceFolder}`). Anything
  else named `oort`, such as a remote URL or extra args, is yours. `connect`
  and `disconnect` then refuse (exit 2) and leave the file untouched. So do an
  unparseable file and a Codex `oort` entry written as an inline table.
- **Disconnect needs no bin.** `disconnect` also removes an entry left by an
  older install path, so it works even from a temporary copy.

After connecting, restart the host. Claude Code and Gemini CLI list servers
with `/mcp`, Codex with `codex mcp list`, Cursor under Settings > MCP, and VS
Code with "MCP: List Servers".

### Scope

The server's memory scope is a project, plus global memories:
- **Cursor and VS Code** fill in `--project ${workspaceFolder}` with the open
  workspace's folder. If a host passes the placeholder through unfilled, or
  empty because no folder is open, `oort mcp` says so on stderr and uses the
  directory it was started in.
- **Claude Desktop** does not start servers in a project, so its scope is
  usually global.
- **Claude Code, Codex and Gemini CLI** start the server in a directory they
  choose, usually your project.

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
| `recall` | `query` (1–500 chars), `as_of?` (ISO date or date-time), `known_at?` (ISO), `mode?` (`current`, `as-of`, `history`, `known-at`), `limit?` (1–10, default 5) | read-only, idempotent | facts: `id`, `text`, `type`, `tier`, `valid_from`, `valid_to` (for a version that is not current), `stale` (a volatile fact not confirmed lately), `why` (for example `lexical #1, dense #2, rerank 0.91`); `mode`, the time mode used (for example `as-of 2026-04-02`); a `note` when recall is lexical-only |
| `remember` | `facts` (1–5 strings, each one line of 1–500 chars), `type?` (a hint: `semantic`, `episodic`, `procedural`, `preference`) | write, not destructive, not idempotent | per fact: `outcome` (`added`, `reinforced`, `updated`, `superseded`, `corrected` or `skipped`), `id`, `supersedes` (for `superseded` and `corrected`), `reason` (`secret`, `not durable`) |
| `forget` | `id` (required) | destructive, idempotent | `{ forgotten: id }` |
| `pin` | `id`, `pinned` (boolean) | write, not destructive, idempotent | `{ id, pinned, changed }` |
| `explain` | `id` | read-only, idempotent | the memory, its stored decisions, and its supersede chain |
| `list_recent` | `since?` (ISO), `limit?` (1–50, default 20) | read-only, idempotent | memories by `updated_at`, newest first, each with `status` (`current`, `superseded` or `expired`) |
| `whoami` | none | read-only, idempotent | `mode: "local"`, `project`, `version`, which adapters are available, and per role whether it uses `oort-pro`, an `own-key` or is `missing`; no account or email |

Every tool sets `openWorldHint: false` and has a `title`.

`remember` runs each fact through the normal write path, exactly as
`oort observe` builds a turn: a user turn "Remember this: <fact>" and an
assistant turn "Noted: <fact>". The path is scrub, gate, reconcile and the
writer. Secrets are therefore scrubbed, and a fact that is only a secret is
skipped. A duplicate fact reinforces the existing memory, and a contradicting
one supersedes it; the old fact is kept with its validity closed. The tool
needs all three roles of the write path (embed, decide and write), from your
own keys or Oort Pro. Without them it returns an error that names
`oort keys set`, and `recall` keeps working, lexical-only. Through Oort Pro,
a relay refusal (402, 429) comes back as the tool error, and `recall`'s
`note` names it.

**Global memories.** `remember` runs in the server's project, but the
candidates it reconciles against include global memories, as every write does.
So a fact that repeats a global memory reinforces that global memory (its
activation and `lastConfirmedAt`) instead of adding a project copy. This is
intended: one fact stays one memory. A fact that would update or supersede a
global memory never changes it; it becomes a new memory of the project
instead, and the decision log records `cross-scope-target`.

The server instructions:

> Oort is the user's own long-term memory, which they connected on purpose. `recall` searches facts the user chose to keep from earlier sessions: decisions, preferences, project details. Use it when the user refers to earlier work, or when their past context would change the answer; skip it for self-contained questions. Use `remember` only for durable facts the user stated or confirmed, one standalone sentence each, never secrets or credentials. `forget` deletes permanently.

The first paragraph above stands alone in under 512 characters. A second
paragraph covers scope, the time modes (`as_of`, `mode: "history"`, `known_at`), supersession,
stale facts, batching facts and ids.

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
`settings.json.oort-backup`. Only exact Oort entries are touched: `<bin> hook
<event>` for this bin, or an older one (a bare `oort` bin, or a package's
`oort/dist/main.js` or `oortmem/dist/main.js`), which is replaced in place. A
wrapper such as `cd x && oort hook Stop` is left alone. See
`docs/claude-code.md`.

`oort connect claude-code` is separate. It adds the MCP server to
`~/.claude.json` (through `claude mcp add` when `claude` is on `PATH`), so the
tools are available too.

## Memory commands

| Command | What it does | Flags |
| --- | --- | --- |
| `oort recall <text>` | Recalls memories as they would be injected into the prompt (an `<oort-memory>` block). | `--json` (the full RecallResult, without embeddings), `--as-of <iso>`, `--known-at <iso>`, `--history` (one at a time; see [Time](#time-recall-modes)) |
| `oort explain <query>` | Runs the same recall and shows each stage's rank and score per memory: lexical, dense, RRF, fused, reranked, activation and hydrated. The header names the time mode (`mode: as-of 2026-04-02 (from the query)`). | `--json` (rank, id, type, tier, validFrom, text, explanation; temporal; timings; degraded), `--as-of`, `--known-at`, `--history` |
| `oort revalidate` | Lists volatile facts (a status, a current version, an owner) that nobody confirmed within `recall.staleAfterDays`, oldest first. | `--json` (id, type, text, lastConfirmed) |
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

### Time: recall modes

Every memory has a valid time (`validFrom` to `validTo`: when the fact held in the world) and a
transaction time (`createdAt` to `expiredAt`: when Oort believed it). A recall reads one slice:

| Mode | Flag | What it returns |
| --- | --- | --- |
| `current` | (default) | What is true now and still believed. |
| `as-of` | `--as-of <iso>` | What was true at that time, using everything learned since. A corrected fact never shows: it was never true. |
| `history` | `--history` | Every version of the matching facts, along the supersede chain, oldest first. Versions found only by walking the chain have `explanation.chain`. |
| `known-at` | `--known-at <iso>` | What Oort believed at that time, including facts corrected later. |

Without a flag the mode comes from the query, in code (chrono-node, no model call): "on 2 April
2026" or "in March" is as-of the end of that day, "how has … changed" or "used to" is history,
"what did we believe … on <day>" is known-at. A bare date with no "on", "in" or "as of" stays a
keyword ("2026-05-16 pooling" finds the memory that mentions it). The temporal words are left out
of the search. `--json` reports the view under `temporal` (`inferred: true` when it came from the
query). Validity is a filter; recency only breaks ties in the ranking.

A fact can end two ways. **Superseded**: the situation changed, so the old fact gets `validTo`
(the new fact's start) and `endReason: superseded`. **Corrected**: the old fact was wrong from the
start, so it gets `expiredAt` (when Oort learned) and `endReason: corrected`, and the correction
takes its valid interval. A fact that only gains detail is **refined** in place; its earlier
wording stays in its decisions. Dates in a fact ("until Friday", "starting next week", "since
last Monday") set its interval, resolved against the turn's time, and a date the writer got wrong
("yesterday" written as the wrong day) is fixed from the turn.

**Volatile facts.** The write gate marks facts likely to change within weeks (a status, a current
version, an owner, a deadline). One not confirmed within `recall.staleAfterDays` (default 30; 0
turns it off) is injected with "(may be outdated; last confirmed 2mo ago)" and listed by `oort
revalidate`. Confirming it in a session clears the mark.

## Keys: `oort keys`

```sh
oort keys set voyage      # prompts for the value, hidden (Keychain on macOS, credentials.json elsewhere)
oort keys list [--json]   # where each key comes from: env, keychain or missing
oort keys rm voyage
```

The providers are `voyage` (`VOYAGE_API_KEY`), `typesafe`
(`TYPESAFE_API_KEY`), `anthropic` (`ANTHROPIC_API_KEY`) and `oort`
(`OORT_API_KEY`, the Oort Pro key that `oort login` stores). A set, non-empty
environment variable wins over the stored key. `keys list` prints where each key
comes from (`keychain` means the stored key, in either place below); with `--json` it prints
`[{ "provider", "envVar", "source" }]`. It never prints a value. A missing
`oort` row points at `oort login`. `oort keys set oort` also works, for a key
you created on the account page.

Where keys are stored:

- **macOS:** the Keychain, as `oort.<provider>` items through `/usr/bin/security`.
- **Linux and Windows:** `$OORT_HOME/credentials.json` (default
  `~/.oort/credentials.json`), `{ "version": 1, "keys": { "<provider>": "..." } }`,
  with the file at mode 600 and its directory at 700. Oort refuses to read or
  write the file when its mode is wider than 600 (POSIX): it says so and gives
  the fix, `chmod 600 <file>`, and `oort doctor` reports it as a failure. Keys
  are only read from it, never printed. `oort keys set` prompts with the input
  hidden, or reads one line from a pipe. Windows has no POSIX modes, so the
  file relies on your user profile's permissions.

`OORT_NO_KEYCHAIN=1` switches stored keys off for every command: nothing runs
`/usr/bin/security`, nothing reads `credentials.json`, and `keys set`,
`keys rm`, `login` and `logout` refuse while it is set. See `docs/claude-code.md` for why `ANTHROPIC_API_KEY` should
stay out of your shell profile.

## Oort Pro: `oort login` / `oort logout`

```sh
oort login [--no-browser]
oort logout
```

Oort Pro ($19 a month) means no vendor keys: one Oort key reaches Voyage,
TypeSafe and Anthropic through the relay at `relay.oortcloud.dev`, and your
memories stay on your machine. Subscribe at https://oortcloud.dev/account.

`oort login` signs this machine in, in the style of the OAuth device flow
(RFC 8628):
1. It makes a secret S (32 random bytes) that never leaves this process
   except in the poll body, and starts a session with
   `POST https://oortcloud.dev/api/cli/session`, sending only
   h = base64url(SHA-256(S)) and this computer's OS and host name. The site
   answers with a user code, `XXXX-XXXX` (8 letters, consonants only).
2. It opens `https://oortcloud.dev/account/cli` in your browser (`open` on
   macOS, `xdg-open` on Linux) and prints the code. The page URL carries
   nothing secret. If the browser does not start, if stdin or stdout is not a
   terminal, or with `--no-browser`, it prints the page address instead.
3. On the page you type the code. The page shows when the request started,
   the approximate country it came from, and the OS and host name the CLI
   reported, with the warning "Only approve if you just ran oort login
   yourself". If someone sent you a code, do not approve it.
4. It polls `POST https://oortcloud.dev/api/cli/session/poll` with S in the
   body (never in a URL) every 2 seconds (backing off to 5 while the site or
   the network struggles) until you approve, the request expires (10
   minutes) or you press Ctrl-C. It never asks a question, so it also runs
   without a terminal.
5. On approval the site mints a key named "CLI on <date>" and hands it over
   once, to whoever holds S. A second poll gets 410 `used`. `oort login`
   stores the key as Keychain item `oort.oort` through `security -i` on stdin
   (never in argv) on macOS, or in `$OORT_HOME/credentials.json` (mode 600)
   on Linux and Windows, reads it back to confirm, and prints which roles now
   go through the relay. It never prints the key or its prefix.

| Outcome | Exit | What it says |
| --- | --- | --- |
| Approved and stored | 0 | Signed in; which roles use the relay; undo is `oort logout` |
| Expired (410 `expired`, or 10 minutes passed) | 1 | Run `oort login` again |
| Already used (410 `used`) | 1 | Run `oort login` again |
| The account has its maximum of 20 live keys (409) | 1 | Revoke a key at https://oortcloud.dev/account, then run `oort login` again |
| Too many sign-in requests from this network (429) | 1 | Wait a minute, then run `oort login` again |
| Ctrl-C | 1 | Cancelled; nothing was stored |
| The Keychain or credentials file did not keep the key | 1 | Nothing saved; the unused "CLI on <date>" key can be revoked at oortcloud.dev/account |
| `OORT_NO_KEYCHAIN=1`, or a system with neither the Keychain nor `credentials.json` | 2 | Refused before anything starts: create a key at oortcloud.dev/account and `export OORT_API_KEY=...` instead |

Signing in again replaces the stored key; the old key keeps working until
you revoke it. Neither command sends your email address or any other account
detail: the browser session does the sign-in. The OS and host name are sent so
the page can show you which computer asked; the site deletes the request
within about two hours.

`oort logout` removes the stored Oort key (Keychain item `oort.oort`, or its
`credentials.json` entry). It does not revoke the key
on the server: revoke it at oortcloud.dev/account. If `OORT_API_KEY` is set, it
says so, since that key would still be used.

### The `oort` provider

Every adapter role picks its key on its own:

| Role | Your own key | Through Oort Pro |
| --- | --- | --- |
| `embed`, `rerank` | `VOYAGE_API_KEY` or `oort.voyage` | `POST <relay>/v1/voyage/embeddings`, `/v1/voyage/rerank` |
| `decide` | `TYPESAFE_API_KEY` or `oort.typesafe` | `POST <relay>/v1/typesafe/v1/systemone` |
| `write` | `ANTHROPIC_API_KEY` or `oort.anthropic` | `POST <relay>/v1/anthropic/v1/messages` |

- **A vendor key always wins**, per role. With only `VOYAGE_API_KEY` set and
  an Oort key, embed and rerank call Voyage directly and decide and write go
  through the relay.
- **The Oort key** is `OORT_API_KEY`, then the stored key (Keychain `oort.oort`, or `credentials.json`). It is sent as
  `Authorization: Bearer oort_sk_...` to every route.
- **The relay** is `https://relay.oortcloud.dev`, or `OORT_RELAY_URL` for
  local development against `wrangler dev` (for example
  `OORT_RELAY_URL=http://localhost:8787`). Anything but https, or http to a
  loopback host, is refused, and the roles that would use it are unavailable.
- **Models.** The relay serves `voyage-3.5-lite`, `rerank-3-lite` or
  `rerank-2.5-lite`, and `claude-haiku-5-5`, the defaults. A role configured
  with another model is unavailable through Oort Pro, with a message that
  names the served model and the vendor key to set instead.
- **Refusals.** A relay 402 (subscription not active), 429 (60 requests per 10
  seconds per key or per account, or a monthly cap used up: the 25,000 saves
  or 50,000 recalls, or a fair-use limit on embedding inputs, rerank calls or
  Jev calls) or 401 (key unknown or revoked) becomes one line with the fix and
  https://oortcloud.dev/account, never a stack trace. A relay 503 means a
  provider is busy for every Pro user, not your cap: "Oort Pro is busy, try
  again shortly". `oort observe` prints it and exits 1; `oort recall` degrades
  to lexical-only and prints it on stderr; the MCP `recall` tool puts it in
  `note`; hooks log it and carry on, as they do for any adapter error.
- **No retry on the cap.** A 429 with a `Retry-After` header (the 10-second
  limit) is retried once, as with any adapter. A 429 without one is a
  monthly cap, which waiting does not clear: it is not retried, and the relay's
  own message (which cap, and when it resets) is the line you see. A 503 is
  retried by the adapters like any server error.
- **Jev through the relay** is sent as plain JSON (no zstd) with the model
  pinned to `jev-latest`, because the relay checks every body it forwards.

`oort keys list` and `oort doctor` show which key serves each role.

## Oort Cloud: `oort cloud`

```sh
oort cloud use [--local]
oort cloud status [--json]
oort cloud import [--dry-run] [--yes]
oort cloud export [--out <file>] [--force]
```

With Oort Pro your memories can live in Oort Cloud (stored in the EU) instead of on this machine.
Then the Claude Code hooks, `oort mcp` and the memory commands read and save in your account, and
the dashboard on oortcloud.dev shows them.

- `oort cloud use` checks your account and switches this machine to the cloud. It needs
  `oort login` and an active Pro plan. `oort cloud use --local` switches back. The setting lives in
  `~/.oort/cloud.json`, never in a repository file, so a cloned repository cannot change where your
  memories go.
- `oort cloud import` uploads the local store (every project) in the v1 export format, in requests
  of at most 500 memories (the API takes up to 1,000 lines a call and says where to continue, which
  the CLI follows). It shows the size first and asks before it uploads (`--yes` skips the
  question, `--dry-run` only shows it). It is resumable: if the network drops, run it again and it
  continues where it stopped. It is also safe to run twice: the cloud skips memories it already
  has. Embeddings of the same model and dimension are reused; others are made again in the cloud.
- `oort cloud export` downloads every memory in your account, so you can always go back to local.
  It works in every billing state, including after Pro lapses.
- `oort cloud status` shows the store, the account and plan, the cloud's memory count and import
  progress.

In cloud mode:

| Command or hook | What happens |
| --- | --- |
| `recall`, `explain`, `inspect`, `pin`, `unpin`, `forget`, `stats`, `export`, `observe` | Call the API for this project (plus account-wide memories). Short ids need at least 8 characters; the API looks them up and refuses a prefix that matches more than one memory. |
| UserPromptSubmit, SessionStart | Recall from the cloud within the hook's time limit (SessionStart: pinned memories, then the hot tier). On a timeout or any error they inject nothing and still exit 0. |
| Stop | Unchanged: queues the new turns on this machine and starts a drain. It never calls the network. |
| The drain | Sends queued turns to the cloud, each with a `turnRef` (`<session>:<turn>`), so a drain that crashes after a save and runs again does not save the turn twice. If the account cannot save (signed out, no plan, a limit, an outage), the turns stay queued and are sent on a later run. |
| `oort mcp` | The same seven tools, answered by the cloud. |
| `consolidate`, `import claude-code` | Refused: the cloud consolidates itself, and transcript import writes to the local store (import locally, then `oort cloud import`). |

No vendor key is read in cloud mode: Oort Cloud calls the models. `OORT_CLOUD_URL` points the CLI
at another API (https, or http to localhost for `wrangler dev`). Errors are one line with the fix,
and never contain your key.

## `oort doctor`

```sh
oort doctor [--json]
```

`oort doctor` checks everything Oort depends on and prints a fix for each
problem. It reads only: it never creates the store or writes a config. Its one
network call is `GET <relay>/health`, made only when a role goes through Oort
Pro, with no key and a 3 second timeout.

| Group | Checks | A problem and its fix |
| --- | --- | --- |
| `keys` | Per role, the key that wins: your own (env or stored) or Oort Pro (env or stored), presence only. On Linux and Windows, also that `credentials.json` is not wider than mode 600. | A wider file: `chmod 600 <file>`. No key: `oort keys set <provider>, or oort login (Oort Pro)`. A model the relay does not serve: use the default model, or set the vendor key. |
| `hooks` | The Claude Code hooks in `~/.claude/settings.json`: all three events, for this bin. | Missing, from another path, or a command that is not executable: `oort install claude-code`. Unparseable settings: fix the JSON, then `oort install claude-code`. |
| `mcp` | Each host's `oort` entry: connected, from another path or version, a command that is not executable, someone else's, or a file that does not parse. | `oort connect <host>`, or fix the file by hand. A host found but not connected is listed with `oort connect <host>` to try. |
| `store` | `~/.oort/oort.sqlite` opens, and how many memories are visible from here; `~/.oort` is not readable by others. | Does not open: close other oort processes and run `oort stats`. Readable by others: `chmod 700 ~/.oort`. |
| `relay` | The relay URL in use, and, when a role goes through Oort Pro, whether its `/health` answers within 3 seconds. | An invalid `OORT_RELAY_URL`: unset it. Unreachable (a warning): check your network or proxy. |

Each check has a status: `✓` ok, `!` warn, `✗` fail, `·` info and `?`
unknown. A relay that does not answer `/health` is a warning, not a failure:
Oort still works locally, and recall falls back to lexical-only. A failed check
makes doctor exit 1; warnings alone exit 0.

```
oort doctor · 1 to fix
keys
  ✓ embed   own voyage key (Keychain oort.voyage)
  ✓ write   Oort Pro (Keychain oort.oort), through the relay
...
mcp
  ✗ cursor  Oort's entry in ~/.cursor/mcp.json runs a command that is not an executable file
            fix: oort connect cursor
```

With `--json` it prints `{ "ok": boolean, "checks": [{ "group", "name",
"status", "detail", "fix"? }] }` and nothing else.

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

- `oort connect vscode --profile <id>` for a named VS Code profile.
- ChatGPT and claude.ai web or mobile: need the remote MCP URL that comes with
  Oort Cloud (CON-42).
