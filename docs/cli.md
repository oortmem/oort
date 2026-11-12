# The `oort` command line

Reference for every `oort` command. The guides on the site link here for exact
flags, file paths and output. `oort <command> --help` prints the same flags.
To use the same memory from your own code, see [the TypeScript SDK](sdk.md).

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

The connect step installs the [managed copy](#the-managed-copy-oortcli) in
`~/.oort/cli` and writes its path into agent config files, so the hooks and
MCP entries run a copy that stays put. `npx oortmem setup` works the same way.

To update later, run `oort update` (see [Updating](#updating-oort-update)).

### The managed copy: `~/.oort/cli`

The Claude Code hooks and the MCP entries run one copy of oort, the managed
copy, installed with:

```sh
npm i -g --prefix ~/.oort/cli oortmem
```

Agents run its `~/.oort/cli/lib/node_modules/oortmem/dist/main.js` by that
path (`$OORT_HOME/cli` when `OORT_HOME` is set). A global install under a Node
version manager (nvm, fnm, Volta, asdf, mise, nodenv, nvs) moves when you
change Node, fnm's
`fnm_multishells` links last one shell, and npx keeps its copy in a cache. The
managed copy belongs to Oort and stays where it is. `oort update` keeps it
current.

- **`oort setup`** installs it when you connect an agent, unless there is
  already one of this version or newer. It runs `npm i -g --prefix
  ~/.oort/cli oortmem@<this version> --prefer-online` the way `oort update`
  does: the first `npm` on `PATH` by its absolute path, no shell, from your
  home directory, with npm's delay after a release waited out. It counts the
  install only after checking that `~/.oort/cli/bin/oort` resolves to that
  release. An older managed copy is brought up to this version.
- **`oort install claude-code`**, **`oort connect <host>`** and
  **`oort install <host>`** write the managed copy's path when it is there,
  checks out and is this version or newer. Otherwise they write the copy you
  ran, when it stays put. They never write a copy in the npx or pnpm dlx
  cache, a temp directory, `fnm_multishells` or a version manager's
  directory. From such a copy, `npx oortmem install claude-code` say, they
  install the managed copy first: the same `oortmem` package from npm's
  registry, at the version you ran, without a separate question (one line says
  so; `oort connect --dry-run` installs nothing and shows where the managed copy
  would be). When they cannot (no `npm` on `PATH`, npm fails, Windows), they
  refuse (exit 2) and name the commands: `npm i -g --prefix ~/.oort/cli
  oortmem`, then `~/.oort/cli/bin/oort install claude-code`.
- **Only a copy nobody else can change.** Agents run the path oort writes on
  every prompt, so before it reuses the managed copy, and again right before
  any config is written, oort walks the path from `/` down to `main.js`. The
  trust boundary is: nothing that anyone other than you (or root) can write.
  Paths that are yours and writable only by you are trusted; write access to
  your own files is already full compromise of your account.
  - inside `OORT_HOME` (the managed copy), every directory and the file must
    be yours (or root's, above your home directory) and not writable by group
    or others;
  - the whole installed copy is checked too, not only the path to `main.js`:
    every file, directory and link under `~/.oort/cli` (`bin/`, the package,
    its `dist/`, and every package in `lib/node_modules`, where Node looks for
    what is missing) must be yours with no group or other write, and a link
    may point only inside `~/.oort/cli`, judged by what the kernel opens (its native realpath) and by its own owner, and its text must point inside too, and may contain `..` only in the shapes npm writes (`node_modules/.bin/<x>` → `../<pkg>/…`, `bin/<x>` → `../lib/node_modules/<pkg>/…`). The walk stops at 20,000 entries,
    reads only file metadata, and runs once per command (setup, install,
    connect, doctor), never in a hook. npm installs the copy with a umask of at
    least `022`, so its files never come out group- or world-writable;
  - for the copy you ran, when it is written instead (the fallback and
    `--this-copy`), every step must be yours or root's and not writable by
    others, sticky or not. Group write is refused inside your home directory.
    Outside it, it is allowed only from a group whose members can already
    become root: `admin` (80) or `wheel` (0) on macOS, as for Homebrew's
    `/opt/homebrew/lib`; `root`, `sudo`, `wheel`, `admin` or your own private
    group on Linux. Never `staff`, every macOS account's group.
    Everything Node loads from it is walked by the same rules: the package it
    belongs to (the nearest directory whose `package.json` is `oortmem`'s), any
    directory a link in it leads to, and every package it needs at run time
    (`dependencies`, optional ones and installed peers, found the way Node
    finds them, recursively; dev dependencies are left out). That is about
    9,500 entries and 0.3 s from a pnpm checkout of this repository, with a cap
    of 50,000;
  - every `node_modules` Node searches above the managed copy, or above a copy
    of your own and every package of its run-time closure (`~/.oort/node_modules`,
    `~/node_modules`, …), must pass the same path rules, and everything in it
    is walked, and so is every directory a link in them leads to (once, by its
    real path): Node loads from them whatever is not found nearer. Inside
    `OORT_HOME` the strict rules apply, elsewhere the lenient ones, under one
    cap shared with the rest of the check (100,000 entries for a copy of your
    own). Past the cap the fix is `move <dir> aside`; oort never `chmod`s or
    `chown`s what is in such a folder. A passing folder is remembered for the
    process;
  - Node's global folders are treated the same way, checked and walked:
    each absolute `NODE_PATH` entry, `~/.node_modules`, `~/.node_libraries` and
    `<node prefix>/lib/node`. oortmem is an ES module, and ES modules ignore
    `NODE_PATH`; some of its CommonJS dependencies do not, so the folders count.
    The hook command oort writes does not clear `NODE_PATH`, so hooks inherit
    whatever the agent was started with; oort checks the value it sees when it
    runs. A relative `NODE_PATH` entry is refused (Node resolves it against
    the hook's working directory, such as a repo an agent is working in): make
    it absolute or remove it;
  - every directory a link leads to inside a copy of your own is a package of
    that closure: its real path gets the same ancestor `node_modules` check,
    and its `package.json` run-time dependencies are walked as well.

  A temporary directory never counts: `os.tmpdir()`, `$TMPDIR`, `/tmp`,
  `/private/tmp`, `/var/tmp`, `/private/var/tmp` and `/dev/shm`. A managed
  copy that fails is never reused, installed over, repaired in place or
  worked around: setup skips connecting, `oort install` and `oort connect`
  refuse (exit 2), and `oort doctor` fails, each naming the first path that
  fails. The fix always removes the copy and installs it again, never `chmod`
  or `chown` on it, which would adopt whatever someone else put there:

  ```
  The managed copy in ~/.oort/cli is not safe for agents to run: /Users/you/.oort/cli/lib/node_modules/commander/index.js can be written by group or others (fix: rm -r ~/.oort/cli && oort setup). Oort never repairs a copy like this in place, since what is in it may not be what npm installed.
  ```

  When `OORT_HOME` itself is yours but too open, the fix removes the copy
  first, then tightens it: `rm -r ~/.oort/cli && chmod go-w ~/.oort && oort
  setup`. An `OORT_HOME` that is a symlink to nothing, someone else's, or in a
  temporary directory gets no managed copy: setup falls back as below, and
  `oort install` from npx refuses with the same sentence. A directory of
  someone else's is never offered a `chown`: use one of your own.
- **Without it**, when npm is not on `PATH` or the install fails, setup falls
  back to the copy you ran if it stays put, with a one-line warning and the
  manual command. If the copy you ran does not stay put, setup skips
  connecting and says what to run.
- **Windows:** the managed copy is not set up there yet. `oort setup`,
  `oort install` and `oort connect` skip it and write the copy you ran.
- **`--this-copy`**, for developers testing their own build: `oort setup`,
  `oort install <host>` and `oort connect <host>` write the copy you ran (a
  build from a checkout, say) even when a managed copy is there, and install
  nothing. A copy that does not stay put (a package cache, a temp directory,
  `fnm_multishells`, a version manager) is still refused, because its path
  breaks later whatever you intend: `This oort is in a package cache, which
  agents would lose later, so --this-copy will not write it.` Run the command
  again without the flag to go back to the managed copy. `oort doctor` names a
  copy written this way in an info line, and does not fail or warn, when it
  stays put, is yours, and is this version or newer.

## Updating: `oort update`

```sh
oort update                  # every copy here to the latest release, after one question
oort update --check          # only say what would change; exits 0 either way
oort update --yes --json     # no question, oort.v1 JSON
oort update --version 0.6.3  # this release instead of the latest
```

`oort update` asks npm's registry for the latest `oortmem`, then finds every
copy of oort that matters on this machine:

- **the hooks' copy**, the binary `~/.claude/settings.json` runs (the path
  `oort install claude-code` wrote, or the first `oort` on `PATH` for a bare
  `oort hook …`);
- **this copy**, the one you ran;
- **the managed copy** in `~/.oort/cli` (`$OORT_HOME/cli`), when there is one:
  `oort setup` installs it (see [The managed copy](#the-managed-copy-oortcli));
- **every other `oort` on `PATH`**; the first is what `oort` runs in this
  shell.

Each copy is recognised by where it really lives (its realpath, or for
pnpm's shell shims the script the shim's text names: an absolute path, or a
`$basedir/…` path that stays below the shim's own directory. Whatever it names
counts only as a pnpm global, which is never run: npm never installs shell
shims, so a shim never gets an npm prefix, and any other shim is listed as
unrecognised), and its version is
read from its files: the nearest `package.json` named `oortmem`, or for a PyPI
launcher its `oortmem-<version>.dist-info`. Finding copies never runs one, so
`oort update --check` only reads (and asks npm's registry); a copy whose files
say nothing is listed as "version unknown".

| Kind | Where it lives | What `oort update` does with it |
| --- | --- | --- |
| managed | `~/.oort/cli` | Runs `npm i -g --prefix ~/.oort/cli oortmem@X --prefer-online`. |
| npm global | `<prefix>/lib/node_modules/oortmem`, also under nvm, fnm, Volta or asdf | Runs `npm i -g --prefix <prefix> oortmem@X --prefer-online`. The prefix is named, so this copy changes whichever `npm` comes first on `PATH`. Under fnm, the `PATH` entry is fnm's link for this shell (`fnm_multishells`); the copy itself is the npm global of that Node version. |
| pnpm global | pnpm's global directory (`global/5`, or pnpm 11's isolated `global/v11/<hash>`) | Prints `pnpm add -g oortmem@X`; it never runs pnpm. Where pnpm keeps globals moves with its version and settings, so `oort update` cannot be sure `pnpm add -g` would change this copy: run it with the pnpm that installed it. |
| PyPI launcher | a Python script from `pip install oortmem` or `pipx install oortmem` | Prints `pipx upgrade oortmem` or `<python> -m pip install -U oortmem`. It never runs pip. The launcher runs the npm release it was built for. |
| checkout | `packages/cli/dist/main.js` in a clone of the repository | Prints `cd <clone> && git pull && pnpm install && pnpm build`. |
| temporary | the npx cache, pnpm dlx, a temp directory, or fnm's link for a shell that has ended | Nothing. A temporary copy is never updated in place: npx keeps whatever version a later `npx oortmem` asks for, and the others are deleted by their owner. It says why. |

It runs npm for the hooks' copy, this copy, the managed copy and the first
`oort` on `PATH`, when it is an npm install (managed or npm global) older than
the release. `npm` is the first one on `PATH`, taken only from absolute `PATH`
entries and run by its absolute path, from your home directory (so no
project's `.npmrc` or `package.json` applies); with none, the command is
printed instead. It lists every
other older copy on `PATH` with the command that updates it and the one that
removes it (`npm rm -g --prefix <prefix> oortmem`, `pnpm rm -g oortmem`,
`pipx uninstall oortmem`). It never deletes anything. Installers run with no
shell, one at a time; their output goes to stderr, so `--json` keeps stdout
for the envelope.

- **Checked, not trusted.** An install counts only when the copy then resolves
  to `<prefix>/lib/node_modules/oortmem/dist/main.js` for the prefix it went
  into, and that `package.json` says the release. An installer that exits 0
  but leaves the copy as it was (or pointing somewhere else) is a failure
  (`✗`, `ok: false`, `unverified: true`, exit 1).
- **npm's delay after a release.** For a minute or so after a release, npm can
  answer `ETARGET` (no such version). `oort update` tries again after 5, 10,
  20 and then every 30 seconds, for up to 2 minutes, with a line on stderr
  each time. Any other installer failure stops it at once (exit 1).
- **After installing**, and only with a checked copy: when `oort serve` runs,
  it is stopped. That copy's
  `oort doctor --json` then opens the store, which migrates its schema when the
  release needs that, after copying it, exactly as `oort doctor` does; the
  copy's path is printed. Then the new copy starts `oort serve --detach`
  again. All three run from the copy the hooks use. With no checked copy,
  none of them runs, and it says what to run once one is.
- **Release notes.** It ends with the link:
  `https://github.com/oortmem/oort/releases/tag/vX`.
- **Asking.** One question on stderr: `Update 2 copies of oort to 0.6.3 and
  restart oort serve? [y/N]`. With `--json`, or when stdin is not a terminal,
  it refuses (`needs-confirmation`, exit 2) unless `--yes`. Declining exits 0.
  `--check` never asks and never installs.
- **Exit codes.** `0`: updated, already up to date, declined, or `--check`
  (with or without an update: read `data.upToDate`); `1`: an installer failed
  (the envelope is a success with `exitCode: 1` and says which), or npm's
  registry could not be reached (`network`); `2`: a `--version` that is not a
  version (`usage`), or the missing `--yes`.

With `--json` its `data` is `{ "current", "latest", "from": "npm" |
"--version", "check", "upToDate", "copies": [{ "path", "realpath", "kind",
"version", "roles", "firstOnPath", "action", "command", "removeCommand",
"note" }], "installed": [{ "path", "realpath", "command", "ok", "unverified",
"attempts", "version" }],
"migration": { "ran", "ok", "store", "migrated", "backup" }, "daemon": {
"running", "version", "pid", "restarted", "now" }, "releaseNotes" }`, and
`"declined": true` when you said no. `kind` is
`managed`, `npm-global`, `pnpm-global`, `pypi`, `source`, `transient` or
`unknown`; `roles` lists `hooks`, `running`, `managed` and `path`; `action` is
`update` (run here), `current`, `manual` (a command for you), `listed` (another
copy on `PATH`), `transient` or `unknown`. `upToDate` and `copies` describe
the machine before anything ran; `installed` says what changed.

### The update notice

Once a day oort checks whether a newer release is out, and says so:

- **When a Claude Code (or Codex) session starts**, as a message to you
  (`systemMessage` in the SessionStart hook's output), never as part of the
  model's context: the memory block it gets is the same as without it. Claude
  Code shows `systemMessage` to you; Codex accepts it in SessionStart output
  and surfaces it as a warning in its UI, apart from the context it gives the
  model. At most once a day for each new version, and never after `/compact`.
- **After an interactive command**, one dim line on stderr:
  `Oort 0.6.3 is available (you have 0.6.2): oort update`. Only when stdout
  and stderr are both a terminal, never with `--json` or `OORT_OUTPUT=json`, and
  never for `oort hook`, `oort mcp`, `oort serve`, `oort doctor` or
  `oort update`.
- **In `oort doctor`** (an `updates` line) and **`oort serve status`** (a
  line under the status). Neither puts it in `--json`; for scripts,
  `oort update --check --json` has the data.
- Never in the MCP server.

**What the check sends.** One `GET https://registry.npmjs.org/oortmem/latest`,
with the user agent `oort-update-check`, no version, no id and no cookies,
and a 1.5 second timeout. Nothing about you or your memories. The answer is
kept in `~/.oort/update-check.json` (mode 600, replaced atomically). A hook only
reads that file: when it is a day old, the hook starts a detached background
process that asks npm and rewrites it, so no hook ever waits on the network.
That process gets only `PATH`, `HOME`, `OORT_HOME`, the opt-outs below, and
the proxy and certificate variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`
in either case, `NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`): never an API key. It reads at most 1 MB of the answer. When
`~/.oort` is a symlink, it is followed only to a directory of yours that group
and others cannot write; otherwise the check is skipped, and `oort doctor`
says why.
A failed check is not retried until the next day. `oort doctor` and
`oort serve status` only read the file.

**Turning it off.** Any one of these turns off both the check and the notice:
`OORT_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER` set to anything, a CI
environment (`CI` set, and not `false` or `0`), or in `~/.oort/config.json`:

```json
{ "updates": { "check": false } }
```

Only the home config is read for `updates`; a repository's `oort.config.json`
cannot change it (the key is ignored there, with a warning). `oort update`
itself still asks npm when you run it.

## Conventions

**Output.** A human-facing command prints one header line, then aligned
key/value rows or a table:

```
oort stats · project oort-1a2b3c4d
scope     oort-1a2b3c4d (+ global memories)
tiers     hot 8, warm 40, cold 0
...
```

On a colour terminal the header starts with the wordmark (`◉ oort stats · …`),
keys are muted and status symbols are coloured: `✓` done, `!` needs a look, `✗`
failed, `•` for information. Tier names use the oortcloud.dev tier colours: hot
(Photosphere) is cyan, warm (Kuiper Belt) is ember orange and cold (Oort Cloud)
is slate blue. Where a row shows a tier with its glyph, the glyphs are `●` hot,
`◐` warm and `○` cold. A one-line confirmation (`pin`, `forget`, `project link`,
`keys set`) is its own header.

`oort` with no arguments prints the help, like `oort --help`. It groups the
commands by purpose (Start, Memory, Agents, Cloud and sharing, Maintenance) and
ends with an example of each common command and where these docs are. `oort
<command> --help` prints that command's own usage and flags. On a colour
terminal the help, the start of `oort setup` and a finished `oort login` show
the Oort mark (a dotted spiral with a comet); nowhere else, and never in a pipe.

**Colour.** Colour is on when stdout is a terminal. `NO_COLOR` (set and
non-empty) turns it off and wins over everything else. `FORCE_COLOR=1` turns it
on for a pipe, `FORCE_COLOR=0` turns it off, and `TERM=dumb` turns it off.
`COLORTERM=truecolor` (or `24bit`, or `FORCE_COLOR=3`) uses the exact brand
colours; a `*-256color` `TERM` (or `FORCE_COLOR=2`) the nearest 256-colour
ones; otherwise the terminal's own 16 colours. When `COLORFGBG` says the
background is light (iTerm2, Konsole and rxvt set it), darker shades keep the
contrast.

**`--json`.** Every command except `hook`, `mcp` and a foreground `serve`
takes `--json` (or `OORT_OUTPUT=json`) and then prints one `oort.v1` JSON
envelope on stdout and nothing else there: see [JSON output
(oort.v1)](#json-output-oortv1). `export` and `cloud export` print JSON Lines
to stdout (see `docs/export-format.md`).

**Exit codes.**

| Code | Meaning |
| --- | --- |
| `0` | Success, including a declined confirmation. |
| `1` | Unexpected error. Only the message is printed; add `--debug` for the stack. |
| `2` | Refusal or usage problem, such as a bad flag, missing keys, a file Oort will not edit, or a confirmation that cannot be asked (see below). |
| `3` | Partial success: `oort import claude-code` imported what it could, but some sessions stopped at a failed observation, or `oort forget --everywhere` forgot the memory but did not reach every Constellation holding a copy. Run it again to retry them. |
| `130` | `oort import claude-code` stopped by Ctrl-C (128 + SIGINT, as a shell reports it). What was imported stays; run it again to import the rest. |

`oort doctor` exits 1 when one of its checks fails; warnings alone exit 0 (a
keyless or local-only install is a supported state), and `--json` tells them
apart with `data.status`. `oort login` exits 1
when the sign-in expires, was already used or is cancelled. A status query
exits 1 when what it asks about is not running: `oort serve status` exits 0
only when the daemon answers, and 1 when it is not running, not answering or
waiting for a migration (with `--json` too, which still reports `running:
false`). So `oort serve status || oort serve --detach` starts it only when
needed.

**Never blocks a script.** A command that asks for a confirmation (`forget`,
`import`, `reembed`, `share`, `project privacy public`, `cloud import`, the
`constellation` `remove`, `leave`, `transfer` and `delete` commands, and
`judge withdraw`, `confirm`, `purge` and `pack import`) writes its question to
stderr, never stdout, so it still asks with stdout piped (`oort import
claude-code | tee log`). It refuses (exit 2) instead of asking when stdin is not
a terminal, or when `--json` is set, and names `--yes`, the flag to pass
instead. `setup` takes `--yes` too, and its interactive wizard asks its
questions on stderr as well. Declining a question changes nothing and
exits 0. `oort hook` always exits 0.

**Missing keys.** Every missing-key message gives the same three ways, in this
order: `oort models pull` (free local embed and rerank models, no keys),
`oort keys set <provider>` (your own key), or `oort login` (Oort Pro). Local
models do not decide or write, so saving new memories (`observe`, `remember`,
`import`, the MCP `remember` tool) also needs a TypeSafe and an Anthropic key, or Oort Pro,
even with local models. Recall works without any of them, lexical-only. No
message suggests `export KEY=...`, which would leave the key in your shell
history. Without a Keychain or `credentials.json` (`OORT_NO_KEYCHAIN=1`, CI,
containers), where `oort keys set` and `oort login` cannot keep a key, the
messages name the variable to set in the environment your agent starts with
instead.

**Secrets.** No command prints a stored key, not even a prefix. An argument
echoed in an error message is scrubbed first (every known key format, Oort keys
included, becomes `[REDACTED:<kind>]`) and then clipped to 24 characters, so a
value in an unrecognised format shows at most its first 23 characters.
Everything Oort saves is scrubbed on your machine before it leaves, in local
and cloud mode: a turn, a fact or a shared text bound for Oort Cloud goes
through the same scrubber as the local write path (the API scrubs again), and
one that is mostly secret is skipped without any request. `oort cloud import`
scrubs each memory again as it uploads it.

**Environment.**

| Variable | Effect |
| --- | --- |
| `VOYAGE_API_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY` | Your own vendor keys. Each wins over the stored key (Keychain item or `credentials.json` entry) of the same provider. |
| `OORT_API_KEY` | Your Oort Pro key. It wins over the stored `oort` key (Keychain item `oort.oort`). |
| `OORT_RELAY_URL` | The Oort Pro relay root, for local development against `wrangler dev` (default `https://relay.oortcloud.dev`). https only, or http to `localhost`, `127.0.0.1` or `[::1]`. |
| `OORT_SITE_URL` | The site `oort login` signs in at, for local development (default `https://oortcloud.dev`). The same rule applies. |
| `OORT_NO_KEYCHAIN=1` | Switches stored keys (Keychain and `credentials.json`) off for every command (see `oort keys`). |
| `OORT_HOME` | The store directory (default `~/.oort`). |
| `OORT_OUTPUT=json` | Turns `--json` on for every command that has it, as if each were given `--json` (see [JSON output](#json-output-oortv1)). It never changes `oort hook`, `oort mcp` or a foreground `oort serve`. |
| `OORT_HOOK_TIMING=1` | Diagnostics. A `UserPromptSubmit` or `SessionStart` hook prints two stderr lines: `oort-hook <event> via=<process\|daemon> <ms>ms`, and `oort-timing {…}` with the hook log's timings for that prompt (numbers only). In cloud mode these include `cloudMs` (the whole request), `cloudHeadersMs`, `cloudBodyMs`, `cloudConnected` (1 when the request opened a connection) with `cloudDnsMs`, `cloudTcpMs` and `cloudTlsMs`, `cloudRecallMs` (the API's recall itself), the API's own stages as `server<Name>Ms`, and `serverLexicalFirstHit` (1 when the API answered from its lexical search without embedding the prompt, 0 when it embedded): the hook asks Oort Cloud for its `Server-Timing` breakdown. A daemon adds `socketMs`, and asks Oort Cloud for Server-Timing only when it was itself started with the variable. |
| `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, `COLORFGBG` | See Colour above. |

## JSON output (oort.v1)

Scripts and agents get one contract from every command: pass `--json`, or set
`OORT_OUTPUT=json` once in the environment. Every command takes it except
`oort hook` (the Claude Code hook protocol), `oort mcp` (the MCP protocol on
stdio) and `oort serve` in the foreground (a long-running log; `serve status`,
`serve stop` and `serve --detach` do take it). Those three never print an
envelope, whatever is set: `OORT_OUTPUT=json` leaves their output byte for byte
as it is, and an explicit `--json` on a foreground `serve` is refused on stderr. `oort export` and
`oort cloud export` (and `oort judge pack export`) write their own format to
stdout, JSON Lines and a pack; with `--out <file>` and `--json` they print the
envelope instead.

> **Breaking change in 0.6.0.** Before 0.6.0, `--json` printed each command's
> own shape: a bare array for `inspect`, `revalidate`, `keys list`,
> `galaxy list`, `constellation list`, `invites`, `members` and `contested`,
> `{ ok, checks }` for `doctor`, a bare object elsewhere, and nothing for an
> error. From 0.6.0 every one of them prints the envelope below: read `data`
> (lists are wrapped: `data.memories`, `data.keys`, `data.checks`), and check
> `ok`. `observe` without `--json` still prints its bare result.

**On success**, stdout holds exactly one document:

```json
{
  "schema": "oort.v1",
  "command": "constellation create",
  "ok": true,
  "data": { "id": "c_aaaaaaaaaaaaaaaa", "name": "oort-core" },
  "warnings": [{ "code": "lexical-only", "message": "lexical-only recall. No embed model or key. …" }]
}
```

- `command` is the command path without `oort`: `recall`, `judge pack import`;
  `serve` reports `serve status`, `serve stop` or `serve start` (`--detach`).
- `exitCode` appears only when the command succeeded but exits non-zero:
  `serve status` when the daemon is not running (1), `models verify` with a
  changed file (1), `doctor` with a failed check (1), `import` with failed
  sessions (3) or stopped by Ctrl-C (130), `forget --everywhere` with a
  Constellation not reached (3).
- `data` is always an object; a list is wrapped (`{ "memories": [...] }`).
  Field names are camelCase and stable, ids are full ids (never the 8-character
  prefix tables show), and times are ISO 8601.
- `warnings` lists, with a code, what is also printed on stderr for people:
  a degraded recall (`lexical-only`, `recall-degraded`), a time mode the store
  did not report (`time-mode-unreported`), the wiring's own warnings
  (`project-id-untrusted`, `cloud-unavailable`, `keychain-unreadable`, …),
  `partial` (`import`, exit 3), `interrupted` (`import`, exit 130),
  `no-dashboard` (`open` with no target on a machine that is not signed in),
  `redacted` and `embed-failed` (judgments),
  `reembed-needed`, `checksum-mismatch` and `optimize-skipped` (models),
  `another-oort-on-path` (`install`), `managed-copy-unavailable` (`setup`:
  agents run the copy you ran instead of `~/.oort/cli`),
  `env-key-set` (`logout`), and for `forget` in Oort Cloud `still-shared`,
  `removal-requested`, `unreachable` and `shares-unknown`. The stderr line
  stays.
- Human lines a command prints along the way go to stderr in JSON mode.

**On failure**, stdout holds one document too, and the one-line message stays
on stderr:

```json
{
  "schema": "oort.v1",
  "command": "forget",
  "ok": false,
  "error": {
    "code": "needs-confirmation",
    "message": "This needs a confirmation, but --json never asks; re-run with --yes to forget it.",
    "fix": "oort forget 1b2c3d4e-… --json --yes",
    "exitCode": 2
  }
}
```

Two optional fields say whether trying again can help, as the SDK's
`OortError` does: `retryable` is `true` for a network failure or a service
that is busy or down (`network`), a rate limit (`refused`, HTTP 429) and a
local store locked by another process (`internal`); `retryAfter` is the number
of seconds the service asked to wait (its `Retry-After` header), when it sent
one. Both are absent otherwise, so read a missing `retryable` as "a retry
alone will not fix this":

```json
{
  "schema": "oort.v1",
  "command": "recall",
  "ok": false,
  "error": {
    "code": "refused",
    "message": "Oort Cloud limit reached (HTTP 429): … Usage is at https://oortcloud.dev/account.",
    "fix": null,
    "exitCode": 2,
    "retryable": true,
    "retryAfter": 30
  }
}
```

`fix` is a command you can run as it is, where one fixes it, else `null`. The
"same command with `--yes`" fix repeats your arguments only when every one of
them is a known flag, a subcommand, an id, a name or an enum; anything else
(`share --text …`, `--by`, a file path) is never echoed back, and the fix is
then the sentence `re-run the same command with --yes`. `exitCode` is the
process's exit code. A usage error from the argument parser has every argument
it names scrubbed and clipped to 24 characters, in the envelope and on stderr
alike, so a key pasted as an extra argument never comes back.

| `error.code` | When | Typical `fix` |
| --- | --- | --- |
| `usage` | A bad flag or argument, a missing file, an input Oort refuses to parse; commander's own usage errors too. | `oort --help` |
| `not-found` | No such memory, judgment, model, Galaxy, Constellation or contest. | `oort constellation list`, `oort models list` |
| `ambiguous-id` | An id prefix that matches more than one memory, judgment or Galaxy. | |
| `needs-key` | No model or key for a role the command needs. | `oort models pull`, `oort keys set typesafe` |
| `needs-login` | No Oort key, or Oort Cloud rejected it. | `oort login` |
| `needs-confirmation` | A command that asks first, run with `--json` or without a terminal on stdin. | the same command with `--yes`, or that sentence |
| `cloud-only` | A command or flag that needs Oort Cloud, on a machine using the local store. | `oort cloud use` |
| `network` | Oort Cloud, the relay, the sign-in site or a model download could not be reached, or is down. | |
| `refused` | A rule said no: a plan or role limit, the hive beta, a Star agent writing the Planet, cloud mode for a local-only command (`consolidate`, `reembed`, `judge`). | |
| `internal` | Anything else: a bug or an unexpected failure. | |

`refused` is a code the issue's first draft did not list: without it, a
Constellation's rule or an inactive plan would read as `usage` and tell an agent
to change its arguments.

**Exit codes** stay as in [Conventions](#conventions): `0` success (a declined
question and doctor's warnings included); `1` an unexpected error, a status
query whose subject is not running or not well (`serve status`, `models
verify` with a changed file, `doctor` with a failed check: the envelope is a
success that says so, with `exitCode: 1`), and an error raised outside the
CLI's own checks, whatever its code (an adapter's relay or key error, a
network failure, a sign-in that did not complete); `2` every refusal and usage
error from the CLI itself; `3` partial success; `130` an import stopped by
Ctrl-C. A failure envelope's
`exitCode` always matches the process's, and a success envelope carries one
whenever it is not 0.

The envelope is printed once the command and its cleanup (closing the store)
have finished: if anything fails after the data was ready, stdout holds the
failure envelope instead, never both. `--debug` prints the stack on stderr for
every error that exits 1.

**One example per family.**

```sh
oort recall "auth port" --json | jq '.data.memories[0].text'
oort inspect --json | jq '.data.memories | length'
oort remember "We deploy on Fridays." --json # { "results": [{ "fact": 0, "outcome", "id", "supersedes"?, "reason"? }] }
oort forget 1b2c3d4e --yes --json            # { "id", "forgotten": true, "everywhere", "withdrawnFrom", "removalRequested", "unreachable", "stillShared", "constellations" }
oort consolidate --json                      # { "promoted": [ids], "demoted", "evicted", "expired", "counts": {…}, "complete" }
oort import claude-code --since 14d --yes --json   # { "outcome", "estimate": {…}, "imported": { "observations", "outcomes", "failedSessions", "notAttempted"? } }
oort open memory 1b2c3d4e --json             # { "target": "memory", "url": "https://oortcloud.dev/dashboard/memories/…", "opened": false }
oort judge record --subject … --json         # { "outcome", "id", "judgment" }
oort judge withdraw 9f8e --yes --json        # { "id", "withdrawn": true, "changed", "by" }
oort keys list --json                        # { "keys": [{ "provider", "envVar", "source" }] }
oort models pull --json                      # { "models": [{ "id", "role", "downloaded", "optimized" }], "used", "config" }
oort connect cursor --json                   # { "action", "dryRun", "command", "binary", "changes": [{ "host", "file", "changed", "diff", "backup", "memory" }] }
oort install claude-code --json              # { "harness", "action", "file", "changed", "command", "events", "version", "binary", "installedManaged" }
oort setup --yes --agents none --keys skip --json  # { "agents", "keys", "import", "demo", "command", "managed", "changed": [{ "what", "undo" }] }
oort cloud import --yes --json               # { "total", "toUpload", "uploaded", "imported", "skipped", "reembedded", … }
oort constellation members oort-core --json  # { "members": [...] }
oort constellation remove oort-core mb_… --yes --json   # { "constellation", "member", "removed": true }
oort serve status --json                     # { "running", "socket", "pid", … } (exit 1 when not running)
oort doctor --json                           # { "status": "ok"|"warn"|"fail", "problems", "checks": [{ …, "fixCommand"? }] }
oort update --check --json                   # { "current", "latest", "upToDate", "copies": [{ "path", "kind", "version", "action", "command" }], … }
```


## `oort setup`

```sh
oort setup                       # interactive, on a terminal
oort setup --yes --agents claude-code,codex --keys byo --import skip
```

| Flag | Values | Default with `--yes` |
| --- | --- | --- |
| `--yes` | Never ask: every choice comes from the flags. | |
| `--agents <list>` | `detected`, `none`, or a comma list of `claude-code`, `claude-desktop`, `codex`, `cursor`, `gemini`, `vscode`. | `detected` |
| `--keys <mode>` | `byo`, `pro`, `local` or `skip`. | `byo` |
| `--import <age>` | `skip`, or an age such as `14d`, `30d`, `12h` or `2w`. | `skip` |
| `--no-demo` | Skip the remember, recall and forget check. | the check runs |
| `--this-copy` | For developers testing their own build: agents run the copy you ran, not the [managed copy](#the-managed-copy-oortcli); nothing is installed. | the managed copy |

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
   - **Local models.** No keys, no account: runs `oort models pull`, which
     downloads the small embedder and reranker (58 MB) and switches to them
     (see [No API keys: local models](#no-api-keys-local-models)). It needs
     `@oortmem/local-models` installed; if the package or the download is
     missing, setup says why and carries on. Undo: `oort models rm`.
   - **Skip.** Recall works lexical-only until keys are set.

   Setup also shows whether an Oort key exists (`OORT_API_KEY` or Keychain
   `oort.oort`). If one does, this step asks nothing: the key already covers
   every role without a vendor key.
3. **Connect.** Claude Code gets the hooks (`oort install claude-code`). Every
   other agent gets the MCP entry (`oort connect <host>`). On a terminal, setup
   first shows the dry-run diff for every agent and asks once before writing
   any of them.

   The path written is the [managed copy](#the-managed-copy-oortcli) in
   `~/.oort/cli`. When there is none of this version or newer, setup installs
   it first, as part of the same step. On a terminal the preview lists the
   install, `+ npm i -g --prefix ~/.oort/cli oortmem@<version>
   --prefer-online`, and the question becomes `Install oort <version> in
   ~/.oort/cli and write these changes?`. Declining installs nothing and
   writes nothing. With `--yes` it installs without asking, because running
   setup is the request to install. It prints one line before npm runs and
   one after; npm's own output goes to stderr. If npm is missing or fails,
   agents get the copy you ran, when it stays put, with a warning:

   ```
   ! The managed copy in ~/.oort/cli could not be installed (npm failed), so agents run this copy: /usr/local/lib/node_modules/oortmem/dist/main.js. For one that stays put: npm i -g --prefix ~/.oort/cli oortmem, then oort install claude-code.
   ```

   Under `npx oortmem setup` the copy you ran is in npx's cache, so without
   the managed copy setup skips connecting and says what to run. The npx path
   is never written, and neither is `npx -y oortmem`. With no agents chosen,
   nothing is installed. On Windows the managed copy is skipped and agents run
   the copy you ran. `--this-copy` skips it too (see the flags above).
   `--install-global`, from before the managed copy, is
   still accepted and does nothing. An agent whose file Oort will not edit
   (invalid JSON, or an `oort` entry you wrote yourself) is reported and
   skipped, and the others still connect.

   With `--json`, `data.command` is the path written (or `null`),
   `data.binary` is `managed`, `running` or `null`, and `data.managed` is `{ "prefix", "status", "version", "command", "reason" }`.
   `status` is `installed`, `reused`, `declined`, `failed`, `unavailable`
   (`reason`: `no-npm` or `unsupported`) or `skipped` (no agents, or
   `reason` `this-copy`).
   `failed` gives `reason` `failed` or `unverified`.
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
| The managed copy in `~/.oort/cli` | `npm rm -g --prefix ~/.oort/cli oortmem` (after `oort uninstall claude-code` and `oort disconnect <host>`) |
| Imported sessions | review with `oort inspect`, remove with `oort forget <id>` |
| A new store in `~/.oort` | `rm -r ~/.oort` (deletes every memory) |

Ctrl-C at a question cancels the rest. Setup then prints what had already
changed, with each undo command, and exits 1.

## `oort connect <host...>` / `oort disconnect <host...>`

```sh
oort connect cursor codex
oort connect cursor --star         # Cursor keeps its new memories in its own Star
oort connect vscode --dry-run      # print the diff, write nothing
oort connect cursor --this-copy    # for developers testing their own build: this copy, not ~/.oort/cli
oort disconnect cursor
```

These commands add or remove one MCP server entry named `oort` in each host's
user-level config. The entry runs the [managed copy](#the-managed-copy-oortcli)
(`~/.oort/cli`) when it checks out, else the copy you ran, as `oort mcp --agent
<host>`, so each host acts as its own agent (see [Agents](#agents-one-planet-a-star-each)).
Cursor and VS Code also get `--project ${workspaceFolder}`, which they replace
with the open workspace's folder.

| Host | File (macOS; Linux and Windows below) | Key | Entry |
| --- | --- | --- | --- |
| `claude-code` | `~/.claude.json` (user scope) | `mcpServers.oort` | `{"type":"stdio","command":"<bin>","args":["mcp","--agent","claude-code"]}` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.oort` | `{"command":"<bin>","args":["mcp","--agent","claude-desktop"]}` |
| `codex` | `~/.codex/config.toml`, or `$CODEX_HOME/config.toml` | `[mcp_servers.oort]` | `command = "<bin>"`, `args = ["mcp","--agent","codex"]` |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers.oort` | `{"type":"stdio","command":"<bin>","args":["mcp","--agent","cursor","--project","${workspaceFolder}"]}` |
| `gemini` | `~/.gemini/settings.json` | `mcpServers.oort` | `{"command":"<bin>","args":["mcp","--agent","gemini"]}` |
| `vscode` | `~/Library/Application Support/Code/User/mcp.json` | `servers.oort` | `{"type":"stdio","command":"<bin>","args":["mcp","--agent","vscode","--project","${workspaceFolder}"]}` |

`--star` records in `$OORT_HOME/agents.json` (0600) that the host's new
memories stay in its own Star; `--no-star` sends them to your Planet again
(the default). Neither flag leaves the setting as it is. The host's config
entry is the same either way. `connect` prints where the host's new memories
go.

**Claude Code through its CLI.** Claude Code rewrites `~/.claude.json`
itself, so a running Claude Code could overwrite a direct edit. When `claude`
is on `PATH` (macOS and Linux), `oort connect claude-code` therefore runs
`claude mcp add --scope user oort -- <bin> mcp --agent claude-code`, and `oort disconnect
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
  or the args entries had before `--agent <host>` and, for Cursor and VS
  Code, before `--project ${workspaceFolder}`). `connect` updates such an
  entry, and `oort doctor` calls it outdated until then. Anything
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
"args": ["mcp", "--agent", "codex", "--project", "/path/to/repo"]
```

An entry edited this way counts as yours from then on: `oort connect` and
`oort disconnect` leave it alone.

### Agents: one Planet, a Star each

Your memory is your **Planet**. Every agent you connect (Claude Code, Codex,
Cursor, …) acts as its own agent, named after its host, and they all read and
write the same Planet: what Claude Code learned, Codex can recall. Each agent
also has a **Star**, private memory that no other agent reads, changes or
counts.

- **Where new memories go.** To your Planet, unless the agent keeps a Star
  (`oort connect <host> --star`). An agent that keeps a Star writes its new
  memories there and still reads your Planet, but never changes it: `forget`,
  `pin` and the like on a Planet memory are refused (exit 2, or a tool error),
  and re-observing a Planet fact only raises its activation.
- **What a recall reads.** Your Planet and the agent's own Star, never another
  agent's Star. When the answer mixes the two, each injected line names where
  it came from: `- [semantic, your Planet, 2d ago] …` or
  `- [semantic, Star cursor, 5h ago] …`. A recall that finds only your Planet
  looks exactly as before.
- **Conflicts.** An agent never edits a memory outside its home: when it
  learns something that contradicts your Planet, it writes its own memory and
  records the contradiction. A recall then ranks the agent's Star memory first
  and keeps the Planet one, marked `overridden by Star cursor`.
- **Which agent.** `oort mcp --agent <id>` (what `oort connect` writes), the
  global `--agent <id>` option on any command, or `OORT_AGENT`. With none of
  them the caller is anonymous: it reads and writes your Planet only, with no
  Star, and `whoami` reports `agent: null`. An MCP entry written before agents
  existed (no `--agent`) runs this way; `oort doctor` flags it and `oort
  connect <host>` rewrites it. The Claude Code hooks and `oort import
  claude-code` always act as `claude-code`. An id is lowercase letters,
  digits, `.`, `_` and `-`; `anonymous` is reserved.
- **Identity is configuration, not authentication.** The agent id is a local
  setting that keeps your agents' memories apart from each other. Any program
  running as you can start `oort mcp --agent cursor` and read Cursor's Star.
  It protects against mix-ups, not against software you run.
- **Oort Cloud has no Stars yet.** In cloud mode an agent that keeps a Star
  can recall your Planet, but its saves (`observe`, MCP `remember`, `forget`,
  `pin`) are refused, and the Claude Code hooks save nothing (one stderr line,
  the prompt goes on; queued turns wait for a local drain). `oort connect
  <host> --star` is refused in cloud mode, `oort cloud use` is refused while
  an agent keeps a Star, and `oort doctor` warns about the combination.

Memories saved before agents existed were all written as `claude-code` and
live in your Planet, so every agent sees them. Nothing is rewritten.

```sh
oort --agent cursor recall "release checklist"            # what Cursor would recall
oort --agent cursor explain "release checklist"           # with a "from" column
oort recall "release checklist" --include planet          # only your Planet
oort recall "release checklist" --include constellation   # exit 2: scope_denied
```

### Any other MCP client

Any client that starts stdio servers can run Oort. Give it the absolute path
of the bin (`readlink -f "$(command -v oort)"`, or `realpath` on macOS) and
the arguments `mcp --agent <name>`:

```json
{ "mcpServers": { "oort": { "command": "/abs/path/to/oort/dist/main.js", "args": ["mcp", "--agent", "my-client"] } } }
```

ChatGPT and claude.ai on the web or mobile need a remote MCP URL. That comes
with Oort Cloud, so they are not hosts here.

## `oort mcp`

```sh
oort mcp [--agent <id>] [--project <dir>]
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
- **Spaces.** What the tools may reach is fixed at start too: your Planet, the
  agent's own Star when an agent is named, and in Oort Cloud the
  Constellations that agent is attached to. `recall` takes `include` (only
  those levels) and `remember` takes `visibility` (`private`, or a
  Constellation it may share to); those are the only space arguments, and a
  `scope`, `project` or `agent` argument from the model is ignored. A
  `remember` meant for a Constellation is saved privately: sharing it stays
  your step, with `oort share`.
- **Agent.** `--agent <id>` (written by `oort connect`) names the agent the
  server acts as: it reads your Planet and that agent's own Star, and writes
  new memories to the Planet, or to the Star when the agent keeps one. A
  memory in another agent's Star is "not found".

Tools:

| Tool | Input | Annotations | Returns |
| --- | --- | --- | --- |
| `recall` | `query` (1–500 chars), `as_of?` (ISO date or date-time), `known_at?` (ISO), `mode?` (`current`, `as-of` with `as_of`, `history`, `known-at` with `known_at`; a mode without its date, or with the other one, is an error), `limit?` (1–10, default 5); on a local store (0.9.0 or newer), also `within?` (a place path) and `near?` (`map_id`, `frame?`, `pose` `{x, y, z?}`, `radius` in metres): see [Places](#places-spatial-memory). Elsewhere (Oort Cloud) they are not offered, and one sent anyway is a tool error (`local-only`), never dropped | read-only, idempotent | facts: `id`, `text`, `type`, `tier`, `valid_from`, `valid_to` (for a version that is not current), `stale` (a volatile fact not confirmed lately), `why` (for example `lexical #1, dense #2, rerank 0.91`), `from` (`from your Planet` or `from this agent's Star`), `overridden_by` (the id of a narrower memory in the result that contradicts it), `place` (its place path) and `distance_m` (with `near`); `mode`, the time mode used (for example `as-of 2026-04-02`; `not reported` from a store that reports none, with `mode_unsupported: true` and a `note` when a mode was asked for); a `note` when recall is lexical-only |
| `remember` | `facts` (1–5 strings, each one line of 1–500 chars), `type?` (a hint: `semantic`, `episodic`, `procedural`, `preference`); on a local store (0.9.0 or newer), also `place?` (`node_id`, `map_id`, `map_version`, `frame`, `pose`, `radius`); elsewhere a `place` is a tool error (`local-only`) and nothing is saved | write, not destructive, not idempotent | per fact: `outcome` (`added`, `reinforced`, `updated`, `superseded`, `corrected` or `skipped`), `id`, `supersedes` (for `superseded` and `corrected`), `reason` (`secret`, `not durable`) |
| `forget` | `id` (required) | destructive, idempotent | `{ forgotten: id }`; in Oort Cloud, when copies were shared to Constellations (they stay), also `stillShared` (their names) and a `note` with the command that withdraws them: `oort forget <id> --everywhere`, which you run and confirm yourself. The model can't withdraw them: a call with `everywhere` is refused before anything is forgotten, with that command |
| `pin` | `id`, `pinned` (boolean) | write, not destructive, idempotent | `{ id, pinned, changed }` |
| `explain` | `id` | read-only, idempotent | the memory, its stored decisions, and its supersede chain |
| `list_recent` | `since?` (ISO), `limit?` (1–50, default 20) | read-only, idempotent | memories by `updated_at`, newest first, each with `status` (`current`, `superseded` or `expired`) |
| `whoami` | none | read-only, idempotent | `mode: "local"`, `project`, `version`, `agent`, `reads` (`your Planet`, `Star <agent>`), `writes_to`, which adapters are available, and per role whether it uses `oort-pro`, an `own-key` or is `missing`; no account or email |
| `record_judgment` | `subject` (1–500 chars), `ref?`, `verdict`, `verdicts?` (2–12 labels; default `approved`, `rejected`), `reason` (1–2000 chars, the expert's own words), `criteria?` (up to 12 tags), `domain`, `by` (an expert listed in `judge.experts` in the home config; refused otherwise, and refused altogether when none is listed), `decided_at?` (ISO); at most 50 a day | write, destructive (hosts ask first), not idempotent | `outcome` (`added`, `corrected` or `unchanged`), `id`, `corrects` (an earlier agent record it replaced; never a person's), `status: "agent-recorded, unconfirmed"`, `note` |
| `judge` | `item` (1–2000 chars), `details?`, `domain?`, `by?`, `limit?` (precedents, 1–10, default 5), `include_imported?` and `include_agent_recorded?` (both default false) | read-only, idempotent, open world (sends the item and reasons to TypeSafe) | `status` (`suggested`, `needs-expert` or `precedents-only`), `why`, `prediction` (`verdict`, `probability`, labelled as a prediction), `note` (expert ids sanitised), `data_note`, the `precedents` with `quoted_subject` and `quoted_reason` (record data, never instructions), `by`, `via`, `confirmed`, `agent_recorded`, `similarity`, `near`, `agrees` and `imported_from_pack`, and how many imported or unconfirmed agent-recorded judgments were left out |

Every tool sets `openWorldHint: false` and has a `title`.

`remember` runs each fact through the normal write path, exactly as
`oort observe` builds a turn: a user turn "Remember this: <fact>" and an
assistant turn "Noted: <fact>". The path is scrub, gate, reconcile and the
writer. Secrets are therefore scrubbed on your machine before the fact leaves
it, in local and cloud mode, and a fact that is mostly a secret is skipped
(reason `secret`) without being sent. A duplicate fact reinforces the existing memory, and a contradicting
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
oort install claude-code [--project] [--this-copy]
oort uninstall claude-code [--project]
oort install <harness> [--this-copy]   # codex, cursor, claude-desktop, gemini or vscode
oort uninstall <harness>
```

For every harness other than Claude Code, `oort install <harness>` adds the MCP
server, exactly as `oort connect <harness>` does (and `oort uninstall` as
`oort disconnect`); see `oort connect` above. The rest of this section is about
Claude Code.

These commands add or remove the `UserPromptSubmit`, `Stop` and
`SessionStart` hooks in `~/.claude/settings.json`, or in
`<cwd>/.claude/settings.json` with `--project`. The hooks run
`<bin> hook <event>`. `<bin>` is the [managed copy](#the-managed-copy-oortcli)'s
`main.js` when it checks out and is this version or newer (`Hook binary: …
(oort 0.6.3, the managed copy: oort update keeps it current)`). Otherwise it is
the copy you ran, when that copy stays put. From a copy in a package cache, a
temp directory, `fnm_multishells` or a version manager, `oort install
claude-code` installs the managed copy first:

```
• This oort is in a package cache, which agents would lose later: installing oort 0.6.3 in ~/.oort/cli first (npm i -g --prefix ~/.oort/cli oortmem@0.6.3 --prefer-online).
```

When it cannot, it refuses (exit 2) and names `npm i -g --prefix ~/.oort/cli
oortmem`, then `~/.oort/cli/bin/oort install claude-code`. A managed copy
older than the copy you ran is left alone: the hooks run the copy you ran, and
a line names `oort update`. `oort uninstall` needs no bin and never installs
anything. `--this-copy`, for developers testing their own build, writes the
copy you ran even when a managed copy is there (see [The managed
copy](#the-managed-copy-oortcli)); `data.binary` is then `running`. The first change keeps a one-time backup at
`settings.json.oort-backup`. Only exact Oort entries are touched: `<bin> hook
<event>` for this bin, or an older one (a bare `oort` bin, or a package's
`oort/dist/main.js` or `oortmem/dist/main.js`), which is replaced in place. A
wrapper such as `cd x && oort hook Stop` is left alone. See
`docs/claude-code.md`.

`oort connect claude-code` is separate. It adds the MCP server to
`~/.claude.json` (through `claude mcp add` when `claude` is on `PATH`), so the
tools are available too.

## The local daemon: `oort serve`

```sh
oort serve [--idle <duration>]   # run in the foreground
oort serve --detach              # start in the background and return
oort serve status [--json]
oort serve stop
```

Every hook is a new process that loads the engine, opens SQLite and reads
keys. `oort serve` keeps one process running that has done all of that
already, so a hook only connects to it, sends its input and prints the answer.
It is optional: without it, the hooks work exactly as before.

- **Which hooks.** `UserPromptSubmit` and `SessionStart`, the two that inject
  context, try the daemon first. `Stop` (which reads the transcript) and the
  drain always run in-process.
- **Fallback.** A hook connects with a 50 ms timeout and waits at most 2.5 s
  (`UserPromptSubmit`) or 1.5 s (`SessionStart`) for the answer. When no daemon
  runs, or it is slow, answers with an error, dies mid-request, speaks another
  protocol version or is another oort version, the hook runs in-process as if
  there were no daemon. A hook always exits 0. The time spent on the daemon
  comes off the hook's own deadline.
- **Circuit breaker.** After a hook times out on the daemon, the hooks skip
  it for 5 minutes; after a protocol or version refusal, or an answer that is not a hook result, for 1 minute. The
  time is kept in `~/.oort/serve.skip-until` (mode 600, an epoch-ms time and
  the reason), which a hook reads once before anything else. A missing or
  unreadable marker means the daemon is tried. A successful answer removes
  it, and so do `oort serve`, `oort serve status` and `oort serve stop`.
  `oort doctor` shows when the hooks skip the daemon, and until when.
- **After an upgrade.** The daemon never migrates the store. When a new
  version needs a schema migration, `oort serve --detach` and
  `oort serve status` say so and point to `oort doctor`, which migrates the
  store and lets the hooks try the daemon again straight away.
- **Same answer.** The daemon runs the same handlers, so it injects the same
  `<oort-memory>` block with the same scrubbing, and it writes the same hook
  log lines, with `"daemon": 1` in `counts`. Like the in-process hook, it does
  not use a local reranker for `UserPromptSubmit`.
- **Socket.** It listens only on a Unix socket, `~/.oort/oort.sock` (or
  `$OORT_HOME/oort.sock`), with mode 600. There is no TCP listener unless you
  ask for service mode (below). When that
  path is too long for a Unix socket, it uses `<hash>.sock` in
  `$XDG_RUNTIME_DIR/oort` when that is set, else in `/tmp/oort-<uid>`. The
  directory must be a real directory (never a symlink, which is not followed)
  of yours that nobody else can write; the daemon creates it 0700 and refuses
  anything else, as it refuses anything but one of your sockets at the path.
  A hook never connects to a socket, or a directory, that is not yours alone.
- **Not a boundary against yourself.** The socket keeps other users out. Code
  running as your own user can still connect to it, or answer on it, and there
  is no token file. So a hook prints a daemon's answer only when it is exactly
  what the in-process hook emits for that event (one `<oort-memory>` block of
  at most 10,000 characters, no other keys); anything else is ignored, the hook
  runs in-process, and the circuit breaker opens.
- **One per Oort home.** `oort.pid` beside the socket is the lock. A second
  `oort serve` refuses (`already running (pid N)`). A daemon that was killed
  leaves its socket and pid file behind; the next start replaces them.
- **Store.** The daemon serves only the store under its own Oort home, and it
  never migrates it. It refuses to start when the store needs its schema
  migration (run any other `oort` command first). When it finds that need
  later, it refuses the request and the hook falls back.
- **Freshness.** It keeps up to 8 engines warm, one per project
  configuration, and re-wires each in the background once it is a minute old.
  An engine is also keyed on the files your stored keys and cloud identity
  come from (`credentials.json`, `cloud.json`, the login keychain), so
  `oort logout`, `oort keys set|rm` or `oort cloud use` take effect on the next
  request. Its environment is frozen: it keeps the variables it was started
  with (`VOYAGE_API_KEY`, `OORT_CLOUD_URL` and so on), whatever the hook's own
  environment holds. After changing one, run `oort serve stop`.
- **Stopping.** SIGTERM and SIGINT stop it cleanly, removing its socket and pid
  file. It also exits after `--idle` without a hook request (default
  `serve.idleMinutes`, 30 minutes). `--idle` takes `30m`, `45s`, `2h` or
  `500ms` (from 100 ms to 24 h).
- **Oort Cloud connection.** In cloud mode the daemon keeps its HTTPS
  connection to Oort Cloud open, so a prompt's recall does not pay for DNS,
  TCP and TLS (about 200 ms from Europe). It opens the connection when it
  starts listening, keeps an idle one for 2 minutes, and for 15 minutes after
  the last prompt refreshes an idle one shortly before that with
  `GET /health` (no key, nothing read, nothing metered). `oort mcp` keeps its
  connection open the same way, without the refresh.
- **Limits.** At most 64 connections, 8 requests waiting on one connection,
  frames of 4 MiB, 10 s without a whole request, and 60 s per connection.
- **Requests.** Each frame is a 4-byte length and JSON: `{ v, id, method,
  params }`, answered `{ v, id, ok, result }` or `{ v, id, ok: false, error: {
  code, message } }`. The methods are `ping`, `status`, `stop`, `hook` and
  `recall`. A `hook` or `recall` request carries the client's `version`: another
  version is refused with `version-mismatch`, except that a newer one gets
  `restarting` on a `hook` (see "After an update" below). Every request is checked against a schema; an unknown method or an
  unexpected field is refused. No parameter names a file: `cwd` only selects
  the project, as the hook input's own `cwd` does.

Start it on demand with `serve.autostart` in `~/.oort/config.json` (default
off). `SessionStart` then starts a detached daemon when none runs, and that
session's prompts use it. When that start fails, or the daemon refuses to start
(a pending migration, a bad directory), the circuit breaker opens for a minute,
so not every session tries again. Only the home config is read for `serve`: a
`serve` key in a repository's `oort.config.json` is ignored, with a warning.

```json
{ "serve": { "autostart": true, "idleMinutes": 30 } }
```

`--detach` and autostart write the daemon's output to `~/.oort/logs/serve.log`
(mode 600). It holds start and stop lines only, never a prompt or a memory.
`oort serve status` shows the pid, version, socket, uptime and how many
requests it served. It exits 0 when the daemon answers and 1 when it does not
(`--json` still prints the state, with `running: false`), so
`oort serve status || oort serve --detach` works. `oort doctor` shows the same under `serve`.

**After an update.** `oort update` stops the old daemon and starts the new
one itself. Otherwise the daemon gives way on its own: when a hook from a newer
oort reaches it, the daemon answers (the error code `restarting`; that hook
runs in-process, with no circuit breaker) and exits, and the hook starts a
daemon of its own version in its place, whatever `serve.autostart` says, since
one was running. A second `restarting` within a minute means something keeps
starting an older daemon: the hooks then open the circuit breaker for its
usual minute instead of starting another (`~/.oort/serve.restarting` holds the
time of the last one). Only a newer hook does this, and only the `hook` method: an
older or equal version, a version that does not parse, `ping` and `status`
never stop it, so two copies of different versions cannot take turns. A
daemon from before 0.6.3 does not do this; the hooks then run in-process until
it exits, or until `oort serve stop && oort serve --detach`.

### The memory protocol: HTTP on the socket

The daemon's socket also serves the SDK's operations over HTTP/1.1 with JSON, protocol `v1`
(the native Python client, [docs/python.md](python.md), speaks it, and any language can). Every
request runs through an SDK handle, so grants, scope rules, limits and error codes are the SDK's;
every answer is one `oort.v1` envelope, and a failure carries the `OortError` `code`, `message`,
`fix`, `retryable` and `retryAfter`.

| Route                                                            | SDK method           |
| ---------------------------------------------------------------- | -------------------- |
| `GET /v1/health`                                                 | version, protocol, mode, capabilities |
| `POST /v1/recall`, `/v1/observe`, `/v1/remember`                 | `recall`, `observe`, `remember` |
| `GET /v1/memories?since=&limit=`, `GET /v1/memories/:id/explain` | `recent`, `explain`  |
| `DELETE /v1/memories/:id?everywhere=`                            | `forget`             |
| `POST /v1/memories/:id/pin`, `/unpin`                            | `pin`, `unpin`       |
| `POST /v1/judgments`, `/v1/judgments/apply`, `/v1/judgments/:id/confirm` | the judgment methods |
| `POST /v1/consolidate`                                           | `consolidate`        |

Headers choose the handle: `Oort-Cwd` (a percent-encoded absolute path; it only selects the
project, as a hook's cwd does), `Oort-Project`, `Oort-Project-Config`, `Oort-Agent`, `Oort-User`,
`Oort-Org`, `Oort-Judge-Role`, `Oort-Operator`. Bodies are JSON objects of at most 4 MiB, headers
at most 16 KiB, 30 s per request. There are no CORS headers, and a request with an `Origin`
header is refused, so a web page cannot reach the socket or a loopback listener. No request names
a file to read or write.

### Service mode: `oort serve --listen`

```sh
oort serve token [--rotate] [--json]               # writes ~/.oort/serve.token, mode 600; never prints it
oort serve --listen 127.0.0.1:7807 --org acme      # foreground, under your supervisor
```

For a container sidecar, or a backend that is not you. The same protocol on TCP, with these rules:

- **Loopback by default.** A non-loopback `--listen` address is refused unless you add
  `--behind-tls-proxy`: the daemon speaks plain HTTP, so put TLS in front of it.
- **A token on every request** except `/healthz` and `/readyz`: `Authorization: Bearer <token>`
  (the scheme is case-insensitive). The token is 256 bits of base64url (at least 43 characters),
  from `OORT_SERVE_TOKEN` (up to two, comma separated, for rotation), else the file
  `OORT_SERVE_TOKEN_FILE` names, else `~/.oort/serve.token` (checked to be mode 600 and yours).
  **Prefer the file**: an environment variable can be read from `/proc/<pid>/environ` (and by
  anything that inherits the environment). A mounted secret file must be a regular file of yours
  or root's that neither group nor others can write and others cannot read (mode 640 is fine),
  in a directory others cannot write, opened without following a link in its last component
  (the links an orchestrator puts in the path are resolved once, first). It is compared in
  constant time as a SHA-256 digest, is removed from the environment the daemon's children
  inherit, and is never logged or printed.
- **Rotation takes effect on the next request.** With a token file, the service checks the
  file's identity and times on each request (one `stat`) and reads it again when it changed, or
  on `SIGHUP`: after `oort serve token --rotate` the old token gets 401 at once and the new one
  works, with no restart. A file that goes missing or invalid accepts no token until fixed.
  An `OORT_SERVE_TOKEN` value is fixed for the life of the process.
- **An end user on every memory request.** Every route needs `Oort-User` (a missing one is
  `400 user-missing`, as in the SDK, so a client that forgot its user can never act as the
  org's one shared Planet). `Oort-User: -` says so on purpose: org-level memory, or agent-level
  with `Oort-Agent`.
- **A loopback listener checks `Host`.** Bound to `127.0.0.1`, `::1` or `localhost`, it answers
  only to `localhost`, `127.0.0.1` or `[::1]` with its port, so a rebound DNS name gets 403
  (`host-refused`). Behind a proxy (`--behind-tls-proxy`) the proxy owns that check.
- **Connection slots are limited and the proxy must rate-limit.** Headers must arrive within
  5 s, a request within 30 s, idle connections are reaped every second, and the listener takes
  at most a fixed number of connections; that stops a slow client from holding every slot, not a
  flood. With `--behind-tls-proxy`, the proxy must rate-limit and cap connections per client.
- **The token decides the org** (`--org` or `OORT_SERVE_ORG`, never `local`): the service acts as
  that org's agent, not as you. `Oort-Cwd` and `Oort-Org` are refused; name the project with
  `Oort-Project` (`-` for none).
- **Foreground only**: no `--detach`, no idle exit. The store must be on a local disk, not a
  network filesystem. The refusal is best effort: it reads the filesystem type on Linux (NFS,
  SMB/CIFS, FUSE, 9p, Ceph, AFS, GPFS, Lustre) and checks nothing on macOS or Windows, and a
  network volume a container runtime presents as a local one is not seen.

## Memory commands

| Command | What it does | Flags |
| --- | --- | --- |
| `oort recall <text>` | Recalls memories as they would be injected into the prompt (an `<oort-memory>` block), as the acting agent: your Planet and its own Star. The header names the agent (`as cursor`). | `--json` (the full RecallResult, without embeddings; each memory has `origin`), `--include <levels>`, `--as-of <iso>`, `--known-at <iso>`, `--history` (one at a time; see [Time](#time-recall-modes)), `--within <path>`, `--near <x,y[,z]>` with `--radius <m>`, `--map <id>` and `--frame <id>` (see [Places](#places-spatial-memory)), `--limit <n>`, `--speed <speed>`, `--budget-chars <n>` (see below) |
| `oort remember <fact>` | Saves a fact you state, as the MCP `remember` tool and the SDK's `remember()` do: one turn framed as your statement (`Remember this: <fact>`, answered `Noted: <fact>`), through the write path (scrub, gate, reconcile, writer), as the acting agent on the cwd's project. The fact is scrubbed on your machine before it leaves, in local and cloud mode; one that is mostly a secret is `skipped (secret)` and never sent. Words without quotes are joined into one fact; a fact is one line of at most 500 characters (no line or paragraph separators). The header says what happened (`added 1b2c3d4e`, `superseded 1b2c3d4e (replaces 9f8e7d6c)`, `skipped (not durable)`; an outcome Oort does not know is `unknown`). In Oort Cloud it saves in your account, as `observe` does, with a `turnRef` built from the project, the type and the fact and the UTC day, so a retry after a lost answer is not saved twice. | `--type <type>` (a hint: `semantic`, `episodic`, `procedural` or `preference`; the write path decides), `--place <path>` and `--pose <x,y[,z]>` with `--map <id>`, `--radius <m>` and `--frame <id>` (where the fact is; local only, see [Places](#places-spatial-memory)), `--dry-run` (reports scrubbing only; touches nothing), `--json` (`data.results`, the SDK's `RememberResult`) |
| `oort explain <query>` | Runs the same recall and shows each stage's rank and score per memory: lexical, dense, RRF, fused, reranked, activation, hydrated, and where it came from (`your Planet`, `this agent's Star`, with `(overridden)` when a narrower memory contradicts it). The header names the agent, the nodes read (`reads: your Planet, Star cursor`) and the time mode (`mode: as-of 2026-04-02 (from the query)`). | `--json` (agent; read; rank, id, type, tier, validFrom, text, explanation, origin, place; temporal; spatial; timings; degraded), `--include <levels>`, `--as-of`, `--known-at`, `--history`, `--within`, `--near` (with `--radius`, `--map`, `--frame`): with one, a `place` and `dist m` column and a `place:` header line |
| `oort revalidate` | Lists volatile facts (a status, a current version, an owner) that nobody confirmed within `recall.staleAfterDays`, oldest first. | `--json` (`data.memories`: id, type, text, lastConfirmed; `data.staleAfterDays`) |
| `oort inspect [id]` | Lists current memories, or shows one in full with its decisions and supersede chain. | `--json`, `--limit <n>` (default 50) |
| `oort stats` | Counts per tier and validity, store and cold sizes, the hook queue, when the store was last consolidated (and when it is next due), and memory use. | `--json` |
| `oort observe` | Runs the write path on one turn, from JSON on stdin or from `--user` with `--assistant`. It prints its result as JSON; with `--json`, inside the envelope. | `--dry-run` (reports scrubbing only), `--json` |
| `oort forget <id>` | Deletes a memory everywhere. It asks first on a terminal. In Oort Cloud, a copy shared to a Constellation stays (it is the team's memory now): the question says where (`also shared to oort-core; add --everywhere to withdraw your copies`), and so does a `still-shared` warning with `--json`. See [Forgetting a shared memory](#forgetting-a-shared-memory). | `--yes`, `--everywhere` (Oort Cloud: also withdraw your shared copies; a removal request where others contributed) |
| `oort pin <id>` / `oort unpin <id>` | A pinned memory is never sent to cold storage. | |
| `oort consolidate` | Expires, re-tiers and evicts memories, every project and the global ones: your Planet, the acting agent's Star, and the Star of every agent configured with `--star`. Each node, and inside it each project and the global memories, is re-tiered on its own. The hooks also run it about daily (see `docs/claude-code.md`); a manual run counts as that day's. | |
| `oort export` | A backup of what you own in the cwd's project plus global: your Planet and the Star of every agent this machine knows (each host, every agent in `agents.json`, the acting one), as v2 JSON Lines with each memory's level in `address`. `--format 1` writes Planet memories only. Withdrawn judgments are left out. | `--out <file>` (0600), `--force`, `--format 1\|2`, `--include-withdrawn` |
| `oort import claude-code` | Imports Claude Code transcripts. It prints the estimate first, then asks. On a terminal a progress line on stderr shows how far it is (see below). It exits 3 when some sessions stopped at a failed observation (the rest are imported; run it again to retry them), and 130 when Ctrl-C stopped it. | `--since <age>`, `--yes`, `--estimate-only`, `--include-unresolved`, `--projects-dir <dir>` |
| `oort import <file>` | Reads an Oort export (from `oort export`, `oort cloud export` or an end user's export from Oort Cloud) into the local store. It shows how many memories are new, then asks; the question says how many are pinned or judgments (both shown to your agent at every session start), and where each memory's text goes to be embedded again (Voyage AI, with your Voyage key or through the Oort relay, or this machine's local model). Planet memories move to this machine's Planet; memories of a Star or a Constellation are left out and counted; ids already here are skipped, so running it twice is safe. The file is not trusted: each memory is rebuilt from its content (text, stub, entities, type, salience, pin, project, a well-formed source, its dates) and starts as a new one here (warm, never read, never confirmed). A date after now becomes now, and a year outside 0000 to 9999 is not read; a planned end (`validTo`) is kept even when still ahead, an expiry ahead of now is dropped, and every end must hold together, or the line is left out (an ended fact never arrives as a current one); a `supersedes` link is kept only to another memory of the same file. A line no store would write is left out and counted as not valid; a file that repeats an id, or is over 100 MB, is refused. A judgment arrives as an imported one (normalised and redacted as from a pack, never confirmed), so it counts only when judging includes imports; one the file says was withdrawn or purged is not imported (the summary says how many), since only a person here may end a decision. [What an import keeps and resets](export-format.md#version-1). Local mode only: in cloud mode, run `oort cloud use --local` first. With `--json`: `{ outcome, file, memories, imported, skipped, outside, invalid, ended, pinned, judgments }`. | `--yes` |

`oort recall` takes the SDK's recall options as flags. `--limit <n>` returns
at most `n` memories, 1 to 50 (default `recall.returnK`, 10). `--speed fast`
skips the reranker and `--speed lexical` calls no model at all (keyword
search only); `full`, the default, embeds and reranks. A stage `--speed` turns
off is not reported as degraded. `--budget-chars <n>` caps the printed
`<oort-memory>` block at `n` characters (default `recall.budgetChars`, 6000;
at least 30, since the block's tags take 29); the header then counts the
memories that fit (`3 memories (of 6; --budget-chars)`, or `none fit
--budget-chars`). `--json` lists every memory either way.

```sh
oort recall "auth port" --limit 3 --speed fast
oort recall "auth port" --budget-chars 1500
```

```sh
oort remember "We deploy on Fridays."
oort remember --type preference "I prefer pnpm over npm."
oort remember "The CI key is in 1Password." --dry-run   # what the scrubber would redact
```

**Import progress.** While `oort import claude-code` reads transcripts and then
observes their turns, it redraws one line on stderr, at most ten times a
second:

```
  ━━━━━━────────── 340/1200 turns · 52 facts kept · 1m 12s · ~4m 10s left
```

Reading shows `reading 3/40 transcripts · 120 new turns`; observing shows the
turns done, the facts kept so far (added, updated, superseded or corrected),
failures when there are any, the time taken and, after two seconds, the time
left. The line never wraps and is erased before anything else is printed, so
the estimate and the closing `Imported … observations` line read as before. It
is drawn only when stderr is a terminal: never with `--json` (or
`OORT_OUTPUT=json`), in a pipe or log, or with `TERM=dumb`, which print no
progress at all. `NO_COLOR` keeps the line without the bar.

The first Ctrl-C while it observes stops after the observation in progress
(`Stopping after the observation in progress …`): each session's cursor is
then at a turn that finished, so nothing is half-imported and running the same
command again imports exactly the rest, none twice. It prints
`Imported 1 of 5 observations: …` and `Stopped by Ctrl-C: 4 observations were
not attempted …`, and exits 130 (with `--json`: `outcome: "interrupted"`,
`imported.notAttempted`, an `interrupted` warning and `exitCode: 130`). The exit
code is 130 even when some sessions had already failed; `failedSessions` still
lists them. A second Ctrl-C quits at once. Ctrl-C while it reads the transcripts
or asks stops before the first observation, so nothing has been written.

Ids are full ids or unique prefixes. Every command reads the cwd's project
plus global memories, as the acting agent (`--agent`, `OORT_AGENT`, else
`claude-code`): your Planet and that agent's own Star.

`--include` takes a comma list of levels: `self` (where the agent's new
memories go), `planet`, `star` (the agent's own), `constellation` and
`galaxy`. Asking for a level the agent cannot read exits 2 with
`scope_denied` rather than an empty answer. Locally there are no shared
levels. In cloud mode a recall reads your Planet and, for accounts in the
Constellations beta, the Constellations you belong to (see
[Constellations](#constellations-oort-share)).

### Large stores: the binary vector index (0.9.0 or newer)

Dense recall compares the query with every hot and warm memory's int8 vector, so each query reads
all of them: 544 MB at a million memories of 512 dimensions. Past 100,000 memories Oort keeps a second index, a
1-bit code per vector, so a query reads about a fifth as much (101 MB at a million). It takes the
10 × k nearest codes (500 for the default 50 dense candidates) and rescores them with their int8
vectors, so scores stay the same; a memory the codes rank outside those candidates can be missed.
The index saves memory, not time: with everything cached, a query takes about as long. The
measurements are in [the design note](design/2026-11-11-binary-quantization.md#9-measurements).

```json
{ "store": { "vectorIndex": "auto" } }
```

`store.vectorIndex` in `~/.oort/config.json`: `auto` (the default) builds the index the first time
an `oort` command opens a store that holds 100,000 searchable vectors (`store.binaryAutoThreshold`
changes the number) and keeps it from then on; `binary` builds it on the next `oort` command,
whatever the size; `int8` never uses one and drops one already built. The build reads the stored
vectors (no model or vendor is called), prints `Building the binary vector index (N vectors)…`,
and is safe to interrupt. Hooks never build or drop it. Only the home config is read for `store`;
a repository's `oort.config.json` cannot change it (the key is ignored there, with a warning).
`oort doctor` shows which index the store searches.

**The RaBitQ index (opt-in).** `{ "store": { "vectorIndex": "rabitq" } }` builds a different
index instead of the binary one: the same 1-bit codes, but compared with a 4-bit copy of the
query, with an error bound per memory. Only the memories whose bound can still reach the top k are
rescored with their int8 vectors, best first, until none can; at most 10 × k, as the binary index
reads. On the bench's corpora that was about half the binary index's reads, with the same
results as the exact scan; at a million memories, 199 reads a query against 500, and a dense
query took 103 ms against 766 ms with everything cached (see
[the design note](design/2026-11-12-rabitq-index.md#11-measurements)).
The codes live in the store file; each process that searches holds them in memory (about 110
bytes a memory, 112 MB at a million). The scan runs in a native engine on macOS (Apple silicon)
and Linux x64 and arm64 (glibc 2.35 or newer), shipped with Oort; elsewhere the same index runs in
TypeScript, with the same results but a slower scan, and `oort doctor` warns and says why
(`OORT_RABITQ_NATIVE=0` turns the native engine off). The build prints `Building the RaBitQ vector
index (N vectors)…`; `binary` or `int8` drop the index again, and `auto` keeps it once built. A
store that grows to four times the size it was built at is rebuilt once on the next `oort`
command, to recentre the codes.

**Upgrading to 0.9.0.** The first `oort` command (or MCP server, or daemon) after the upgrade
moves the store to schema version 7. Version 5 adds the place columns of
[spatial memory](#places-spatial-memory), after a `pre-v5` copy of the store; version 6
adds the binary index's guard and takes no copy (it only adds; going back to 5 loses nothing), and
builds the binary index only when `store.vectorIndex` asks for it. Version 7 replaces that guard
with one an Oort without the RaBitQ index cannot pass, and adds the RaBitQ index's tables only
when `store.vectorIndex` is `rabitq`; it takes no copy either. Until then
the hooks skip recall and saving for the turn, as after the upgrade to schema version 4, and print one line:
"Oort is upgrading its store; run `oort doctor` once, then restart any Oort MCP server started
before the upgrade". Do that: Oort 0.8 or older refuses to open a version 7 store, and a process
that already had it open (an MCP server or daemon started before the upgrade) can keep reading,
but its next write fails, changing nothing. To go back to 0.8 or older, see
`downgradeSqliteStore` in [the store contract](store-contract.md#sqlite-schema-versions) (`to: 4`).

**The adaptive stop (0.9.0 or newer).** Cold memories are archived: only their stubs are searched,
and returning one reads it back from the cold store and makes it warm again (it is *hydrated*).
When a recall finds cold matches beside hot and warm ones, it first asks whether the hot and warm
memories already answer the query. If they do, the cold matches are left out and nothing is
hydrated. `recall.adaptiveStop` picks who answers:

- `rule` (the default): code, no model call. The hot and warm memories are enough when the query
  has at least two informative words, the top memory is hot or warm and holds all of them, and
  every cold match holds clearly fewer (at least 0.3 less of the query's words).
- `decide`: a full recall (`--speed full`, the default) asks the decision model, one call per
  recall that has cold matches beside hot and warm ones, and stops when its answer reaches
  `recall.sufficientAt` (default 0.7). With `--speed fast` or `lexical`, or without a decision
  model, the rule answers. A question that fails widens, as before, and the recall reports
  `stop-failed` in `degraded`.
- `off`: always widen into the cold matches, as before 0.9.0.

History, as-of and known-at recalls never stop early: the versions they look for are often cold.
`--json` reports it as `adaptiveStop` (`stopped`, `by`, `cold`, and the model's `probability`).

```json
{ "recall": { "adaptiveStop": "decide", "sufficientAt": 0.8 } }
```

Only the home config (`~/.oort/config.json`) is read for these two keys: `decide` sends your
recalled memories' text to the decision model, and a low `sufficientAt` hides cold matches, so a
repository's `oort.config.json` cannot set them (they are ignored there, with a warning; the rest
of its `recall` settings still apply).

### Time: recall modes

Every memory has a valid time (`validFrom` to `validTo`: when the fact held in the world) and a
transaction time (`createdAt` to `expiredAt`: when Oort believed it). A recall reads one slice:

| Mode | Flag | What it returns |
| --- | --- | --- |
| `current` | (default) | What is true now and still believed. |
| `as-of` | `--as-of <iso>` | What was true at that time, using everything learned since. A corrected fact never shows: it was never true. |
| `history` | `--history` | Every version of the matching facts, along the supersede chain, oldest first. Versions found only by walking the chain have `explanation.chain`. |
| `known-at` | `--known-at <iso>` | What Oort believed at that time, including facts corrected later. A fact whose own end (or expiry) had passed by then is not shown; a fact superseded or corrected after that time is. A refined memory shows its latest wording; earlier wording is in its decisions (`refine` / `previous-text`). |

Without a flag the mode comes from the query, in code (chrono-node, no model call):

- "on 2 April 2026", "in March" or "yesterday" is as-of the end of that day. The date words are
  left out of the search. A coming day ("by Friday", "next week") stays current, and a bare date
  with no "on", "in" or "as of" stays a keyword ("2026-05-16 pooling" finds the memory that
  mentions it).
- A history question, asked as one: "how has X changed", "history of X", "what did X used to
  be", "what was X before". Every word stays in the search. A prompt that only mentions a change
  ("fix the test, the config changed") stays current.
- "what did we believe … on <day>" is known-at that day.

`--json` reports the view under `temporal` (`inferred: true` when it came from the query). If the
store reports no view (an older Oort Cloud API), `recall` and `explain` warn on stderr that a
requested mode may not have been applied. Validity is a filter; recency only breaks ties in the
ranking.

A fact can end two ways. **Superseded**: the situation changed, so the old fact gets `validTo`
(the new fact's start) and `endReason: superseded`. **Corrected**: the old fact was wrong from the
start, so it gets `expiredAt` (when Oort learned) and `endReason: corrected`, and the correction
takes its valid interval. A fact that only gains detail is **refined** in place; its earlier
wording stays in its decisions.

Dates in a fact set its interval, resolved against the turn's time, in the turn's UTC offset when
its timestamp has one:

- "until Friday" ends it after that Friday. An end already past ("the freeze ran until
  yesterday") is kept: the fact is stored already ended.
- "starting next week" or "starting Monday" starts it at the coming one, "since last Monday" at
  the past one, and "as of", "effective" or "from" at whichever is closer within a week, else the
  past one. "From Monday to Friday" is a schedule and sets nothing.
- A start earlier than the fact it replaces ("since October" for a fact stored in November) still
  makes the new fact current; the old one is closed at its own start.

When the turn says "yesterday" and the writer put a day one or two off in the fact, the day is
fixed. A date the turn states itself, or one further off, is kept and the difference is logged
(`temporal` / `writer-date`).

**Other languages.** The date words above are read in English only, for now. A query in another
language ("¿qué puerto usaba auth en marzo?", "5月の時点では？") falls back to `current`, which is
what a query without a date gets; nothing is misread. A memory written in another language gets
no stated end or start, so "hasta el viernes" does not end the fact by itself. Numeric dates
(`2026-11-06`) are found in any language, as keywords. In any language, `--as-of`,
`--known-at` and `--history` (and the MCP `recall` tool's `as_of`, `known_at` and `mode`) choose
the mode explicitly. The writer still turns a relative date in any language into an absolute
`YYYY-MM-DD` in the fact's text. Reading dates in Spanish, Brazilian Portuguese, German, French,
Japanese and Chinese is planned (CON-110).

### Places: spatial memory

In 0.9.0 or newer, a memory can carry where it is: a robot, a phone or anything else that knows
its place. `oort remember` takes one, and `oort recall` and `oort explain` filter by one:

```sh
oort remember "The torque wrench is in drawer 4." --place site:hq/room:B/drawer:4 --pose 12,3 --map hq
oort recall "torque wrench" --within room:B
oort recall "toolbox" --near 13,3 --radius 1.5 --map hq
```

- **A place path** (`--place`) names where, root first: `site:hq/floor:2/room:B/shelf:B3`. 1 to
  16 segments of 1 to 64 letters (any script, with its combining marks), digits and `. _ : @ -`,
  normalised to Unicode NFC. Invisible characters (any Unicode default-ignorable code point, such
  as a variation selector) are refused: `room:B` with one looks like `room:B` but would never
  match it. The joiners follow IDNA's ContextJ rules: ZWJ only right after a virama (Devanagari
  `क्` + ZWJ + `ष`, Malayalam `ന്` + ZWJ), ZWNJ after a virama or between two letters of a
  joining script such as Arabic (Persian `خانه` + ZWNJ + `ی`). Paths compare exactly, so a name
  typed with and without its ZWNJ is two places to `--within`.
- **Map coordinates** (`--pose x,y[,z]`, in metres, with `--map`) say where on a map. `--radius`
  gives the place a size, `--frame` a coordinate frame other than `map`. `odom` is refused:
  odometry drifts, so a fact pinned to it would end up in the wrong place.
- **`--within room:B`** keeps memories whose place path contains `room:B` as whole segments, at
  any depth: `room:B/shelf:B3` matches, `room:B2` never does.
- **`--near x,y[,z] --radius m --map id`** keeps memories within that many metres of the point,
  measured to the edge of the memory's place (0 inside it). Another map or frame never matches.

The filters run in the store before ranking and `--limit`, together (both must hold) and with
every [time mode](#time-recall-modes): `--within shelf:B3 --as-of 2026-11-03` is what was on that
shelf then, and `--history` shows where a moved fact went. A memory without a place never matches
a filter, and a recall without one is unchanged. `--json` adds each memory's `place`,
`explanation.placePath` and `explanation.distanceM`, and the filter under `spatial`.

A turn seen somewhere else than a memory it would reinforce adds a memory instead (decision
`place` / `elsewhere`): the two places differ when their paths differ, or their poses are further
apart than their combined `sigma` (a matching path where only one side has a pose is the same
place). Deciding that a thing moved, and replacing the old place, is
later work.

Places are kept by the local store (schema version 5 and newer; opening an older store adds the columns and
a spatial index, after a `pre-v5` backup). Oort Cloud does not hold them yet: in cloud mode the
flags are refused (`refused`, `local-only`, fix `oort cloud use --local`), and `oort cloud
import` sends memories without their place and says how many it left out.

**Volatile facts.** The write gate marks facts likely to change within weeks (a status, a current
version, an owner, a deadline). One not confirmed within `recall.staleAfterDays` (default 30; 0
turns it off) is injected with "(may be outdated; last confirmed 2mo ago)" and listed by `oort
revalidate`. Confirming it in a session clears the mark. The gate answers this once per turn, so
facts split from a multi-fact turn are not marked yet (a per-fact question is a follow-up).

## Judgment memory: `oort judge`

An expert (a lawyer, a content reviewer, a code reviewer) approves or rejects items and says why.
Judgment memory keeps those decisions, with the reason in the expert's own words, so an agent can
apply them to a new item, show which precedents it used, and say when it is not sure.

```sh
oort judge record --subject "Post says a vitamin cures the flu" --verdict rejected \
  --reason "Health claim with no cited source." --criteria no-source,health-claim \
  --domain content --by ada --ref https://example.test/posts/1
oort judge apply "Story says a herbal remedy cures anxiety" --domain content
oort judge list
oort judge withdraw <id>
oort judge purge <id>
```

A judgment is a memory of type `judgment`. It holds:

| Field | What it is |
| --- | --- |
| `subject` | A one-line summary of what was judged, and optionally `ref`, a link or id of the item. |
| `verdict` | `approved` or `rejected`, or a label from `verdicts`, the defined set (`--verdicts approve,escalate,reject`). |
| `reason` | The expert's own words, kept verbatim (secrets are redacted). Nothing paraphrases it: the write path never refines, supersedes or merges a judgment. |
| `criteria` | Tags the reason relies on (`no-source`, `pii`). |
| `domain` | `content`, `legal`, `code-review`, …: judging only uses precedents of the item's domain when one is given. |
| `by` | The expert's id. A prediction always names whose judgments it came from. |
| `via` | How it was recorded: `cli`, `import`, `pack`, `sdk` (by code in the SDK's expert role, which counts as a person's), or `mcp` (an agent recorded it: over MCP, or through the SDK's agent role, with `source.harness: 'sdk'`). |
| `decidedAt` | When the expert decided (`--decided-at`; default now). |

Judgments are recorded only on purpose: by `oort judge record`, `oort judge import`, a pack, or
the MCP tool `record_judgment`. They are never inferred from a conversation, because the expert
owns what is recorded. Every text field refuses control, bidi and invisible format characters
(the set `shown()` escapes). They belong to the expert, not to a repository: a judgment is global (not
bound to the cwd's project), lives in the acting agent's home (your Planet, or the agent's Star),
and is pinned, so it never goes cold. Recall shows judgments like any memory, as precedent (`[judgment, 2d ago] Judgment by ada (content): rejected "…". Reason: …`).

**Seeing, correcting, withdrawing, purging.** `oort judge list` shows the current judgments,
marking those imported from a pack and those an agent recorded (`--all` adds withdrawn, corrected
and purged ones; `--domain` and `--by` filter).

- **Correcting.** Recording the same item again (same `ref`, domain and expert) corrects the
  earlier judgment, as does `--corrects <id>`: the old one is kept for the record, its validity
  closed, and no longer counts. The same judgment again changes nothing. A correction only ever
  replaces a judgment recorded the same way: an agent's record never corrects a person's.
- **Withdrawing.** `oort judge withdraw <id>` (asks first; `--yes`) records who withdrew it (`--by`,
  else `judge.operator` in the home config, else `local-user`; never the expert by default) and
  closes its validity. Judging, recall in every time mode (current, `--as-of`, `--history`,
  `--known-at`), `oort export` and packs leave it out from then on; `--include-withdrawn` on
  `recall`, `explain` and `export` shows it. Its record and text stay in the store.
- **Purging.** `oort judge purge <id>` (asks first) withdraws it if needed and removes its subject,
  link, reason, criteria, memory text and embedding for good. An audit stub stays: the expert,
  domain, verdict, times, who withdrew and purged it. Copies made earlier (exports, packs, backups)
  are not touched.
- **Tombstones.** A withdrawn, corrected or purged judgment leaves a tombstone: a hash of its
  expert, domain, subject, reason (both case- and whitespace-folded) and verdict, without its
  decision time. A bulk import or a pack whose decision matches one is skipped and counted, so a
  file or a pack never brings back what was taken back, even with its time shifted.

**Agent-recorded judgments.** The MCP tool `record_judgment` is off until you list, in the home
config, the experts an agent may record for (a repository's `oort.config.json` cannot set this):

```json
{ "judge": { "experts": ["ada"], "operator": "marcus" } }
```

An agent can record at most 50 judgments a day per Oort home. What it records is agent-recorded and
unconfirmed: it never corrects a person's judgment (it is recorded alongside), and judging leaves it
out until a person runs `oort judge confirm <id>` in the terminal (there is no MCP tool for that), or
the caller asks with `--include-agent-recorded` (MCP: `include_agent_recorded`). Every result marks
agent-recorded precedents.

### Applying judgments: `oort judge apply`

`oort judge apply <item>` finds the closest current judgments (`--domain`, `--by` narrow them):
by embedding when an embedder is set up, by shared words otherwise. With a TypeSafe key it asks
Jev for a choice over the verdicts the close precedents voted for (a single one is offered against
`other`), with the precedents and their reasons as quoted data, and prints the prediction with its
probability and the precedents behind it. The item and those reasons are sent to TypeSafe. The
answer is one of:

| Status | When |
| --- | --- |
| `suggested` | A prediction at or above `--threshold` (default 0.7) that at least two close precedents agree with. It is labelled as a prediction, never as the expert's decision, and cites every precedent it used with its reason. |
| `needs-expert` | No trustworthy prediction. `why` says which: `no-precedents` (nothing recorded for this domain or expert), `too-far` (nothing at least `--min-similarity` close; default 0.45 by embedding, 0.25 by words), `too-few` (only one close precedent, or only one backs the prediction; the lean is shown), `precedents-disagree` (no verdict holds 60% of the close precedents, weighted by similarity), `low-confidence` (below the threshold; the lean is shown) or `decider-failed`. The closest precedents are shown either way. |
| `precedents-only` | No TypeSafe key: the close precedents and their reasons, and no verdict. |

`--k <n>` sets how many precedents count (default 5); `--json` prints the whole result. Only
judgments made in this store count unless you add `--include-imported`: a pack's experts are
whoever its exporter says they are, so judgments imported from packs are used only when you ask,
and are then marked `imported from pack <name>`. When some were left out, the answer says how many
(`importedExcluded` in JSON). Nothing
is decided for anyone: in a regulated domain, treat every answer as a suggestion a person
confirms.

### Past decisions in bulk: `oort judge import`

`oort judge import <file>` reads CSV (a header row) or JSON Lines (one object per line), chosen by
the file name or `--format csv|jsonl`. Columns: `subject`, `verdict`, `reason`, `domain`, `by`, and
optionally `ref`, `criteria` and `verdicts` (lists separated by `;` in CSV; arrays in JSON Lines)
and `decided_at`. `--domain` and `--by` fill a missing column. A file holds at most 5,000 rows, and
every row is checked before anything is written; the store is read once and embeddings go in
batches. A row whose item (`ref`) the same expert already judged the same way is skipped, and
one they judged differently corrects the earlier judgment, so importing a file with refs twice adds
nothing. Rows without a `ref` are added each time. Rows matching a tombstone are skipped and
reported.

### How well it agrees: `oort judge eval`

`oort judge eval <file>` judges held-out decisions (same format as import; they are never
recorded, and never used as their own precedent: an item's own `ref`, or the very same decision,
is left out) against the judgments in the store, and reports per domain, and for all of them, the
coverage (the share of items predicted) and the agreement with the expert's actual verdict at each
confidence threshold (`--thresholds 0.5,0.7,0.9`; default 0.5 to 0.9), plus why the rest were not
predicted. It needs a TypeSafe key. `docs/examples/judgments-train.csv` and
`docs/examples/judgments-heldout.csv` are a small synthetic set (content moderation and code
review) to try it on:

```sh
oort judge import docs/examples/judgments-train.csv
oort judge eval docs/examples/judgments-heldout.csv
```

### Judgment packs: `oort judge pack`

```sh
oort judge pack export --domain content --name ada-content --out ada-content.pack.jsonl
oort --agent cursor judge pack import ada-content.pack.jsonl
```

A pack is JSON Lines: a manifest (`oort: "judgment-pack"`, `version: 1`, `name`, `exportedAt`,
`exportedBy`, `count`, `digest`, `domains`, `experts`), then one line per current judgment
(`id`, `judgment`). Withdrawn and corrected judgments never travel, and neither do embeddings (the
importer embeds with its own model). Export includes only judgments made here unless you add
`--include-imported`.

Import checks the whole pack before it asks (`--yes` skips the question). The question says
that imported judgments are pinned, so your agent sees them at every session start:

- The `digest` is sha256 over the manifest's `name`, `exportedAt` and `exportedBy` and every
  line, so none of them can change afterwards. Those three must be one line of plain text (no
  control or bidi characters, length-capped).
- `domains` and `experts` must be exactly those of the lines, so the question shows what is
  really inside.
- Every judgment is checked as `oort judge record` checks it, and is rebuilt from its known fields
  only.

Each imported judgment keeps its expert and decision time, and records where it came from in
`judgment.pack`: this pack's id (from its digest), its name, who exported it and when, and the
line's id. A line may say it came from an earlier pack (when the exporter had imported it
itself). That claim is kept apart as `judgment.pack.claimedEarlier`, marked `untrusted: true`, and
used for nothing. Importing the same pack again adds nothing; so does any pack holding a decision
already here (the same expert, domain, subject, verdict, reason and time), and a line matching a
tombstone is skipped and reported, so a pack never brings back a judgment withdrawn or corrected
here. A pack holds at most 5,000 judgments. The digest catches a changed or truncated file, but
it does not prove who made the pack or that its experts really decided: import packs only from
people you trust, and use their judgments with `--include-imported`.

Judgment memory is local for now: in cloud mode the `oort judge` commands refuse, and
`oort cloud import` leaves judgments on this machine.

## Keys: `oort keys`

```sh
oort keys set voyage      # prompts for the value, hidden (Keychain on macOS, credentials.json elsewhere)
oort keys list [--json]   # where each key comes from: env, keychain or missing
oort keys rm voyage       # also: oort keys remove voyage
```

`oort keys create [--name <n>] [--scope <list>] [--json]` makes a new Oort Cloud key for your
account and prints it once (Oort never stores it; revoke it at oortcloud.dev/account). Without
`--scope` it carries everything your account may do. `--scope` narrows it: `planet` (always
first: a key always reads and writes your own Planet), then Constellations by name or id, each
optionally `:read` (recall only) or `:share` (recall and share), such as
`--scope planet,checkout:read`. A narrowed key cannot see any other Constellation, and can only make
keys inside its own scope.

The providers are `voyage` (`VOYAGE_API_KEY`), `typesafe`
(`TYPESAFE_API_KEY`), `anthropic` (`ANTHROPIC_API_KEY`) and `oort`
(`OORT_API_KEY`, the Oort Pro key that `oort login` stores). A set, non-empty
environment variable wins over the stored key. `keys list` prints where each key
comes from (`keychain` means the stored key, in either place below); with `--json` its
`data` is `{ "keys": [{ "provider", "envVar", "source" }] }`. It never prints a value. A missing
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

## No API keys: local models

Embeddings and reranking can run on this machine's CPU instead of through Voyage: no API keys, no
account, and no network after a one-time download. Saving new memories still needs the decision
and writer models (TypeSafe and Anthropic keys, or Oort Pro); a local decision model is CON-16.

```sh
npm i -g @oortmem/local-models   # the runtime: ONNX Runtime, about 115 MB
oort models pull                 # download the default models (58 MB), verify, and use them
oort models [list] [--json]      # the catalog: downloaded, in use
oort models verify [models...]   # re-hash downloaded files against their pins
oort models rm [models...]       # delete them and switch back to the default provider (also: models remove)
oort reembed [--force] [--yes]   # re-embed every memory with the configured embedder
```

`oort setup` offers the same as **Local models** in the keys step (`--keys local`).

**Opt-in only.** Nothing is downloaded until you run `oort models pull` (or pick local models in
`oort setup`): never during a hook, a recall or `oort doctor`. Setting `embed.provider` to
`local` without pulling changes nothing; recall stays lexical and says to run `oort models pull`.
Every file is pinned to a Hugging Face commit and its SHA-256, checked as it downloads; a
mismatch keeps nothing. Files go to `~/.oort/models/<model>` (owner-only), with a manifest
written last and an optimised copy of the graph that loads about five times faster.
`OORT_MODELS_URL` points the pull at a mirror with the same layout.

`pull` writes the choice to `~/.oort/config.json`:

```json
{ "embed": { "provider": "local", "model": "bge-small-en-v1.5" },
  "rerank": { "provider": "local", "model": "ms-marco-minilm-l6-v2" } }
```

| Model | Role | Download | Licence | Use |
| --- | --- | --- | --- | --- |
| `bge-small-en-v1.5` | embed | 34 MB | MIT ([BAAI](https://huggingface.co/BAAI/bge-small-en-v1.5)) | default; English, 384 dimensions |
| `ms-marco-minilm-l6-v2` | rerank | 24 MB | Apache-2.0 ([cross-encoder](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2)) | default; English |
| `qwen3-embedding-0.6b` | embed | 625 MB | Apache-2.0 ([Qwen](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)) | multilingual; for `oort mcp` |
| `bge-reranker-v2-m3` | rerank | 588 MB | Apache-2.0 ([BAAI](https://huggingface.co/BAAI/bge-reranker-v2-m3)) | multilingual; for `oort mcp` |

**Other languages.** Both defaults are English-only. On the multilingual eval
(`packages/bench/eval/multilingual`, 12 languages), bge-small still finds a memory written in the
question's language, mostly through the identifiers it shares, but its dense floor lets through
questions nothing answers, and a question in another language finds the English memory in its
top 10 for 47% to 73% of questions. MiniLM lowers that to 3% to 47%. A multilingual local embedder is
planned (CON-96). Lexical search handles Chinese, Japanese, Korean, Thai and Indic text in any
setup (store schema version 4).

The defaults are small because every Claude Code hook is a new process that loads the model
from disk. Measured on an Apple M1 Max, one thread, CPU time: bge-small loads in about 110 ms
(22 ms from the optimised copy) and embeds a query in 6 ms; MiniLM loads in 60 ms (13 ms) and
scores 16 short documents in 110 ms. The large models take 0.8 to 1 s to load plus up to 1.5 s
to parse their tokenizer, use about 1 GB of memory, and need 120 ms per query or 2.3 s per 16
documents, so they suit the long-lived `oort mcp` server. Runtime: `onnxruntime-node` (MIT) and
`@huggingface/tokenizers` (Apache-2.0), loaded only on first use.

**In the hooks.** The prompt hook (`UserPromptSubmit`) embeds the query locally, loading the
model only when the lexical search is not already confident and the query is not in the
10-minute cache. It does not run the local reranker: loading it on every prompt cost about
450 ms and often ran past the rerank budget, so the hook ranks by fusion and the relevance gate.
`oort mcp` and `oort recall` load both models once and rerank. On a heavily loaded M1 Max (load
average about 300), a prompt hook took 400 to 560 ms at p50 with the local embedder against 245 ms
lexical-only, and found the right memory for 6 of 6 paraphrased questions against 1 of 6. In a
warm process, recall took 137 ms at p50 with a 10 ms embed and a 114 ms rerank of 30 candidates.

**Switching embedders.** Vectors from two models are not comparable, even at the same dimension
(a 384-dimension model is zero-padded to the store's 512, which leaves cosine similarity as it
was). The store records which embedder its vectors come from (`voyage/voyage-3.5-lite`,
`local/bge-small-en-v1.5`); a store from before this was recorded is Voyage's. When the
configured embedder differs, dense recall and saving are off (recall stays lexical and, where a
reranker is set, reranked) until `oort reembed` recomputes every vector, cold copies included,
from the memory's text. `oort doctor` reports the active embedder and any mismatch. Re-embedding
through Voyage asks first, since the provider bills it. `oort cloud import` sends text only from
a store embedded locally, so Oort Cloud embeds it with Voyage.

On Linux x64, npm runs ONNX Runtime's install script, which downloads CUDA libraries Oort does
not use; `ONNXRUNTIME_NODE_INSTALL=skip` skips them.

**Reranker scores.** MiniLM's raw scores (logits) sit near -10 for unrelated pairs and reach
about 10 for clear matches. Oort maps them onto the 0 to 1 scale that `recall.minRerankScore`
(0.35) was set for with Voyage's scores, as `sigmoid(1.5 × logit − 0.93)`. The scaling was fitted
on the bench eval on 2026-11-06 (CON-96):

- Voyage `rerank-3-lite`, when the gate was calibrated (2026-11-04): every answerable row kept a
  memory scoring 0.767 or more, and no abstention row scored above 0.303.
- MiniLM's lowest answerable logit is 1.414. One abstention row scores higher than that: it rates
  "auth service rollback plan for the billing team" against "Rolled back the auth-service
  deploy …" at 2.29. Three paraphrased answers score lower, from 1.41 to 1.89 (for example "which
  package manager does billing-api-15 use" against "billing-api-15 installs dependencies with
  npm").
- No increasing map can separate rows that the model does not. The fit gives up that one
  abstention row, the cheapest choice, and maps 1.414 to 0.767 and the next abstention logit,
  0.062, to 0.303. The gate then sits at logit 0.21, at the same place in MiniLM's margin as in
  Voyage's.
- The map is increasing, so it never changes MiniLM's order. Candidates the model scores alike
  keep the fused order, as they do with Voyage.
- The guessed scaling it replaces, `sigmoid(0.5 × logit + 2.4)`, put the gate at logit -6, so
  almost every candidate passed it.

Recall on the bench eval: `pnpm eval --demo`'s 1,500 synthetic memories and 23-row fixture, with
the relevance gate on.

| Setup | recall@3 | recall@5 | recall@10 | MRR@10 | Abstention rows answered |
| --- | --- | --- | --- | --- | --- |
| Lexical only, no models | 1.000 | 1.000 | 1.000 | 1.000 | 0 of 4 |
| Local: bge-small, no reranker (what the prompt hook runs) | 0.947 | 1.000 | 1.000 | 0.833 | 4 of 4 |
| Local: bge-small and MiniLM, guessed scaling | 1.000 | 1.000 | 1.000 | 0.904 | 4 of 4 |
| **Local: bge-small and MiniLM, fitted scaling** | 1.000 | 1.000 | 1.000 | 0.904 | **1 of 4** |
| Voyage: voyage-3.5-lite and rerank-3-lite (`full`) | 1.000 | 1.000 | 1.000 | 1.000 | 4 of 4 |
| Voyage: voyage-3.5-lite, no reranker (`fast`) | 1.000 | 1.000 | 1.000 | 0.947 | 1 of 4 |

- No setup returned a superseded version (stale leak 0).
- The local rows were measured on 2026-11-06 on an M1 Max, with the rerank budget lifted so that
  load could not cut a rerank short.
- The Voyage rows were not re-run, since that needs a paid API. They are the measurement from
  2026-11-05, taken through Oort Cloud (see `docs/claude-code.md`). The 2026-11-04 calibration
  run answered none of the abstention rows. The cause of that difference has not been looked into.
- The fixture's questions share words with their answers, which favours lexical search. That is
  why lexical-only scores perfectly here. Recall by meaning shows on paraphrased questions
  instead: the local models found the right memory for 6 of 6, against 1 of 6 for lexical-only
  (above).
- MiniLM ranks less well than Voyage (MRR@10 0.904 against 1.000). On the paraphrased "package
  manager" questions it puts an unrelated memory about the same service first. The scaling
  changes which memories pass the gate, not their order, so it cannot fix that.

To re-run it with the default local models pulled (it makes no network calls):
`pnpm --filter @oortmem/bench run calibrate:local -- --home ~/.oort`. With `--record
packages/bench/eval/minilm-logits.json` it also saves MiniLM's raw logits. A test replays them on
every `pnpm test` and fails if the eval falls below this run.

## Oort Pro: `oort login` / `oort logout`

```sh
oort login [--no-browser]
oort logout
```

Oort Pro ($19 a month) means no vendor keys: one Oort key reaches Voyage,
TypeSafe and Anthropic through the relay at `relay.oortcloud.dev`. Your
memories stay on your machine, or in Oort Cloud in the EU after
`oort cloud use` (see `oort cloud`). Subscribe at https://oortcloud.dev/account.

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
| `OORT_NO_KEYCHAIN=1`, or a system with neither the Keychain nor `credentials.json` | 2 | Refused before anything starts: create a key at oortcloud.dev/account and set `OORT_API_KEY` in the environment your agent starts with instead |

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
  seconds per key or per account; a daily or monthly cap used up: 5,000 saves
  or 25,000 recalls a month, a twentieth of those a day, or a limit on
  embedding inputs, rerank calls or Jev calls; or the monthly fair-use limit on
  model costs) or 401 (key unknown or revoked) becomes one line with the fix and
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
oort cloud import [--dry-run] [--yes]    # also: oort cloud upload
oort cloud export [--out <file>] [--force]   # also: oort cloud download
```

`oort cloud upload` and `oort cloud download` are the same commands as
`oort cloud import` and `oort cloud export` (which upload this machine's store
and download your account's, unlike `oort import claude-code`, which reads
transcripts). Both names work; `--json` reports the first.

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
- `oort cloud export` downloads every memory in your account, so you can always go back to local:
  `oort cloud use --local`, then `oort import <file>`. It works in every billing state, including
  after Pro lapses.
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

### Constellations: `oort share`

```sh
oort constellation list [--json]
oort constellation create <name> [--json]
oort share <id> --to <constellation> [--text <text>] [--yes] [--json]
oort forget <id> --everywhere
```

A Constellation is memory you share with a team, in Oort Cloud (an invite-only beta). Nothing you
save moves there by itself: `oort share` copies one memory, on purpose.

- `oort share` shows exactly the text that would be shared first: secrets are always redacted,
  and email addresses, phone numbers, account numbers and IP addresses are marked. Nothing leaves
  your Planet until you confirm (`--yes` on a non-terminal; it never prompts there). `--text`
  shares an edited text instead. The confirmation shares exactly the previewed text, to exactly
  the previewed Constellation (shown with the start of its id), within a few minutes. The copy
  gets its own id and a record of where it came from; your memory stays as it is, and sharing it
  again updates that one copy.
- A memory from a project marked `"private": true` in `oort.config.json` never leaves it. Oort
  Cloud decides from the memory's own project. Recalls, saves and shares made inside a project
  tell it, but only when that project's `oort.config.json` sets `"private"` (true or false); a
  default says nothing. Once a project is recorded as private it stays private, whatever a later
  client says, until you run `oort project privacy public` inside it (it asks; `--yes` on a
  non-terminal). If Oort Cloud doesn't know a project's privacy, its memories are refused: set
  `"private": false` in its config or run `oort project privacy public`, then share again.
- Every member's own recall (no agent named) then reads the Constellation too, and so do the
  agents they attached to it (`oort constellation attach`), labelled with its name:
  `[semantic, Constellation oort-core, 2d ago]`. Shared memories take at most 40% of the injected
  block, so your own memory comes first. A Constellation that does not answer in time is left out
  of that recall (`degradedNodes` in `--json`), never an error.
- `oort forget <id>` leaves a shared copy in place and says where it is; `--everywhere` withdraws
  the copies only you contributed to (see [Forgetting a shared memory](#forgetting-a-shared-memory)).
- `oort constellation list` shows the Constellations you belong to, your role, and how many
  members each has. Members never see each other's own memories.

### Forgetting a shared memory

```sh
oort forget <id> [--yes] [--json]                # your memory; shared copies stay
oort forget <id> --everywhere [--yes] [--json]   # and your copies in Constellations
```

A copy you shared is the team's memory: `oort forget` deletes your own memory and leaves the copy.
It says so first: the question reads `Forget 1b2c3d4e "…" (also shared to oort-core, checkout; add
--everywhere to withdraw your copies)? [y/N]`, a Constellation you left is marked `(you left)`, and
afterwards it prints `Still shared to …` with the command that withdraws them. With `--json` the
same goes in a `still-shared` warning, and `data.stillShared` lists each Constellation.

`--everywhere` also withdraws your copies. In each Constellation that holds one, Oort Cloud does
one of three things:

- **Withdrawn:** you were its only contributor, so the copy is removed.
- **Removal requested:** others contributed (they confirmed or co-wrote it), so the copy stays
  and its maintainers get a request to remove it.
- **Not reached:** the Constellation did not answer, or you left it and this is a narrowed key
  (reaching a Constellation you left needs a full key or the dashboard). The copy stays; run the
  same command again later. This is a partial success: the command exits 3, and the `--json`
  envelope carries `"exitCode": 3` (as `import` does). Removal requests alone exit 0: that is the
  intended outcome where others contributed.

```text
$ oort forget 1b2c3d4e --everywhere
Forget 1b2c3d4e "We deploy with wrangler" and withdraw your copies from oort-core, checkout, design (and any other Constellation you shared it to; where others contributed, its maintainers get a removal request)? [y/N] y
Forgot 1b2c3d4e-….
Withdrawn from oort-core.
Others contributed in checkout: a removal request went to the maintainers, and the copy stays until they decide.
Not reached: design. The copy stays; run `oort forget 1b2c3d4e-… --everywhere` again later (a Constellation you left needs a full key, or the dashboard).
```

```json
{
  "schema": "oort.v1",
  "command": "forget",
  "ok": true,
  "data": {
    "id": "1b2c3d4e-…",
    "forgotten": true,
    "everywhere": true,
    "withdrawnFrom": ["c_aaaa…"],
    "removalRequested": ["c_cccc…"],
    "unreachable": ["c_dddd…"],
    "stillShared": [
      { "constellation": "c_cccc…", "name": "checkout", "member": true },
      { "constellation": "c_dddd…", "name": "design", "member": true }
    ],
    "constellations": [
      { "constellation": "c_aaaa…", "name": "oort-core", "member": true },
      { "constellation": "c_cccc…", "name": "checkout", "member": true },
      { "constellation": "c_dddd…", "name": "design", "member": true }
    ]
  },
  "warnings": [
    { "code": "removal-requested", "message": "Others contributed in checkout: …" },
    { "code": "unreachable", "message": "Not reached: design. …" }
  ],
  "exitCode": 3
}
```

`withdrawnFrom`, `removalRequested` and `unreachable` are Constellation ids; `constellations` names
each one (`member: false` once you left it), and `stillShared` lists the ones that still hold a
copy. Without `--everywhere` the three lists are empty and `stillShared` lists every copy.

The Constellations the question names are what a lookup found a moment before: Oort Cloud acts
on every copy it holds when the command runs, so the question says `(and any other Constellation
you shared it to)`, or `(no shared copies found; any you made will be withdrawn)` when the lookup
found none, and the lines printed afterwards are Oort Cloud's own answer.

A plain forget keeps the record of where the memory was shared, so `oort forget <full id>
--everywhere` still withdraws the copies afterwards (the question then reads `Withdraw your copies
of 1b2c3d4e (already forgotten) from oort-core (and any other Constellation you shared it to)?`);
an id prefix can't find a memory that is gone. If that lookup fails (outside the hive beta, or
Oort Cloud is down), the command says why rather than "not found".
`--everywhere` asks first like every forget: on a terminal only, and with `--json` or a stdin
that is not a terminal it refuses (exit 2) unless you pass `--yes`. Outside the hive beta it is
refused before anything is forgotten, and in local mode it is refused as `cloud-only` (there are
no Constellations there).

An agent can't withdraw your copies. The MCP `forget` tool deletes only your own memory; when
copies stay, its result names them and gives the `oort forget <id> --everywhere` command for you
to run, the same way a `remember` meant for a Constellation leaves sharing to you.

### Teammates: invites, members and agents

```sh
oort constellation invite <c> <email> [--role maintainer|member|reader] [--json]
oort constellation join <link> [--no-browser]
oort constellation invites <c> [--json]          # open invites (maintainers)
oort constellation revoke <c> <invite id>
oort constellation members <c> [--json]
oort constellation role <c> <member> <role>       # maintainers
oort constellation remove <c> <member> [--yes]    # maintainers
oort constellation leave <c> [--yes]
oort constellation transfer <c> <member> [--yes]  # the owner
oort constellation delete <c> [--yes]             # the owner
oort constellation policy <c> [--confirm|--open] [--supersede-trust member|maintainer] [--min-support <1-10>]  # maintainers
oort constellation attach <c> --agent <name> [--share]
oort constellation detach <c> --agent <name>
oort project link --constellation <c>             # maintainers; unlink to undo
```

Joining is by invitation only. `invite` prints a single-use link, valid for 7 days (Oort Cloud also
emails it when it can); send it only to the person invited. They accept it on oortcloud.dev,
signed in with an account whose verified email address is the invited one: `join <link>` opens
that page. Anyone else's account is refused, and there is no public link to join.

Roles:

| Role | Can |
| --- | --- |
| maintainer | everything a member can, plus invite, remove, change roles, bind projects, set the policy and resolve contested memories |
| member | recall, share, and attach their own agents |
| reader | recall only |

The owner (who created it) is a maintainer who can't be removed or leave; only the owner can
transfer ownership (`transfer`) or delete the Constellation (`delete`, which removes every memory
shared in it; members' own memories are untouched). `<member>` is the `mb_…` id `members` prints, or
the member's invited email address. A plan's member limit, and every other rule, is Oort Cloud's:
a refusal prints its own message.

Leaving, or being removed, ends access within a minute: your next recall no longer reads the
Constellation. What you shared stays in it.

An agent reads a Constellation only once you attach it: `oort constellation attach oort-core --agent
claude-code` lets Claude Code's hooks and MCP server read it, and `--share` also lets that agent
share into it. An agent never gets more than your own role allows: a reader can attach agents,
and they read only (`--share` is accepted but capped to read while you are a reader). Commands
with no agent named (`oort recall` without `--agent`) read every Constellation you belong to.

**Limit: attaching narrows only clients that name their agent.** The cloud applies an agent's
attachments when the request names that agent (the CLI does whenever `--agent` or `OORT_AGENT`
is set, and `oort connect` sets it for each host). An agent name is a label, not a credential: a
client using the same key without naming an agent reads every Constellation the key reaches. To
really confine an agent, give it its own narrowed key: `oort keys create --scope planet,<c>:read`.

Changing membership (invite, revoke, remove, roles, leave, attach, detach, transfer), maintaining
(policy, project links, resolving contests, delete) and making keys need a full key or the
signed-in dashboard; a narrowed key is refused.

`policy --min-support <n>` (1 to 10, default 1) is how many members a shared memory needs to
survive an erasure: when someone deletes their account, a memory they wrote or co-wrote is kept
only while at least `n` remaining members support it, and is deleted below that. It applies only to
the erased person's own memories, never to one they only confirmed. `--min-support` can be given
alone or with the other flags; `--json` returns `minSupport` with the policy.

### When teammates disagree

```sh
oort constellation contested <c> [--json]
oort constellation resolve <c> <id> --keep <id> [--json]   # maintainers
```

A shared memory is compared with what the Constellation already holds, the way your own memory
compares a new fact with what you saved before. `oort share` then says what happened when it was
more than a new copy: your share confirmed a memory already there (counted, never making you its
author), added detail to it, replaced an earlier one, or corrected one that was never right. Detail,
replacement and correction each make a new version that is yours; the earlier version stays in
the history, still its author's. Order follows when each fact was observed, not when it was shared: an older fact shared
late is kept as history and never replaces a newer one.

Trust comes from your role: maintainer, then member (readers never share). A share through a
narrowed key or a connector, or of one of your agent's own memories, counts as a member's. The
policy's `--supersede-trust` (member by default, or maintainer) is the least trust needed to
replace someone else's memory. Below it, both memories stay current and recalls show both,
labelled `[semantic, Constellation oort-core · contested, 2d ago]`, until a maintainer decides:
`contested` lists each pair (the current memory and the challenger), and `resolve <c> <id> --keep
<id>` keeps one. Keeping the challenger replaces (or corrects) the current memory; keeping the
current memory retracts the challenger. Both stay in the history either way. A held claim stays
held when its member replaces it with a newer one. Contest labels rest on the model's judgment of
what contradicts what: they are advisory, and someone who words a claim to avoid contradicting it
outright can get it in unlabelled. Withdrawing your copy (`oort forget --everywhere`) or deleting
your account removes the versions you shared and your confirmations; when yours was the current
version, the one before it comes back if its author is still a member.

What you save in your own Planet never changes a Constellation's memory: if you disagree with
one, your own memory says so, and only you see it.

No vendor key is read in cloud mode: Oort Cloud calls the models. `OORT_CLOUD_URL` points the CLI
at another API (https, or http to localhost for `wrangler dev`). Errors are one line with the fix,
and never contain your key.

## Opening the dashboard: `oort open`

```sh
oort open [target] [--no-browser] [--json]
oort open memory <id>
```

Opens a page on oortcloud.dev in your default browser. Oort has no local
viewer: the visual layer, the star map included, is the dashboard, which shows
the memories in Oort Cloud.

| Target | Page |
| --- | --- |
| (none) | The dashboard when this machine is signed in to Oort Pro or uses Oort Cloud (`oort cloud use`); otherwise the quickstart, with a `no-dashboard` warning saying why (`oort open dashboard` opens the dashboard anyway). |
| `dashboard` | https://oortcloud.dev/dashboard |
| `star-map` | https://oortcloud.dev/dashboard/star-map |
| `memory <id>` | https://oortcloud.dev/dashboard/memories/&lt;id&gt;. Oort Cloud only: a prefix (8 characters or more) is looked up to the full id first; on a machine using the local store it is refused (`cloud-only`, fix `oort inspect <id>`). |
| `account` | https://oortcloud.dev/account (plan, usage and keys) |
| `docs` | https://oortcloud.dev/docs |
| `quickstart` | https://oortcloud.dev/docs/quickstart |

On a terminal it prints `✓ Opened <url>`. It prints the address alone on stdout
instead of starting a browser, and exits 0, when stdout is not a terminal (so
`oort open docs | pbcopy` works), with `--no-browser`, with `BROWSER=none`,
when `CI` is set, in an SSH session (`SSH_CONNECTION`, `SSH_TTY` or
`SSH_CLIENT`), and on Linux without `DISPLAY` or `WAYLAND_DISPLAY`; a dim line
on stderr says which. A browser that does not start (no `open` or `xdg-open`,
or it exits with an error) also prints the address and exits 0. `--json`
never opens anything: it prints `{ "target", "url", "opened": false }` in the
envelope. An unknown target or a bad id is a usage error (exit 2).

The browser is `$BROWSER` when it is set (one program name or path, given the
address as its only argument), else `open` on macOS, `xdg-open` on Linux and
`rundll32 url.dll,FileProtocolHandler` on Windows. The address is passed as one
argument, never through a shell, and only an address the CLI built is opened:
https on oortcloud.dev, or a loopback `OORT_SITE_URL` for local development
(any other `OORT_SITE_URL` is refused).

## `oort whoami`

```sh
oort whoami [--json]
oort --agent cursor whoami
```

Which store this runs against, as which agent, and the spaces it reaches: your Planet, the agent's
own Star (local), and in Oort Cloud each Constellation with your role and the rights this key and
agent have there (`Constellation oort-core (member: read, share)`). `oort doctor` lists the same
spaces in its `cloud` group, and the MCP `whoami` tool returns them too.

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
| `keys` | Per role, the key that wins: your own (env or stored) or Oort Pro (env or stored), presence only. A role on a local model instead loads it and runs it once, offline. On Linux and Windows, also that `credentials.json` is not wider than mode 600. | A wider file: `chmod 600 <file>`. No key: `oort models pull (free local embed and rerank, no keys), oort keys set <provider>, or oort login (Oort Pro)`; for decide and write, which no local model does, the key or Oort Pro. Without a Keychain or `credentials.json`, the variable to set in your agent's environment instead. A model the relay does not serve: use the default model, or set the vendor key. |
| `hooks` | The Claude Code hooks in `~/.claude/settings.json`: all three events, and the binary they run. Hooks that run the managed `~/.oort/cli` while you run a copy from `PATH` are fine: the `claude-code bin` row names both, each with its own version. A managed copy that is there but not safe to run (`managed copy`) is a fail, and its fix always removes and reinstalls it (`rm -r <prefix> && oort setup`, with `chmod go-w` on `OORT_HOME` after the `rm` when only `OORT_HOME` itself is too open): Oort never repairs a copy like this in place. | Missing, or a command that is not executable: `oort install claude-code`. Doctor never runs a hook's binary: versions come from the package's files. The managed copy (when it checks out and is safe) and the copy you ran are ok at this version or newer. Any other copy that stays put and is yours, such as your own build written with `--this-copy`, is an info line naming it ("the hooks run another copy at X (oort V)", try: `oort install claude-code` to use the managed copy, or keep it if you built it). A copy in a temp directory or package cache, or one someone else could change, is a fail. A hook binary that is older than the oort you run, or whose files do not say a version, is a warning naming both versions and the path: `oort update` (or `oort install claude-code` from the oort you want). When the oort you run lives somewhere temporary or under a Node version manager (the npx or pnpm dlx cache, a temp directory, `fnm_multishells`, `.nvm/`, `node-versions/`, `.volta/`, `.asdf/`), the fix never points the hooks at it: it names the managed copy instead, `~/.oort/cli/bin/oort install claude-code` (with `npm i -g --prefix ~/.oort/cli oortmem &&` first when there is none). Hooks that run a copy that does not stay put (under a version manager, in `fnm_multishells`, or in the npx or pnpm dlx cache) get an info line (`claude-code node`) naming the fix: with no managed copy, `oort setup, or npm i -g --prefix ~/.oort/cli oortmem and then oort install claude-code`; with one, `~/.oort/cli/bin/oort install claude-code`. Unparseable settings: fix the JSON, then the same fix. |
| `serve` | Whether `oort serve` runs: its pid, version and socket. Not running is information only. Whether the hooks skip the daemon after a timeout or refusal, and until when. | Another oort version than this one (a warning; the hooks run in-process until it restarts): `oort serve stop && oort serve --detach`. A socket nobody answers on, or one that is not yours alone: the same, or remove it. |
| `mcp` | Each host's `oort` entry: connected, from another path or version, a command that is not executable, someone else's, or a file that does not parse. Entries are judged against the binary `oort connect` would write now: the managed copy when it checks out, else the copy you ran. The binary an entry runs follows the hooks' rules, also for an entry that is exactly what `oort connect` writes: the managed or the running copy is ok, another copy of yours that stays put and is this version or newer (one written with `--this-copy`) is an info line naming it, and one in a temp directory or someone else's is a fail. | `oort connect <host>`, or fix the file by hand. A host found but not connected is listed with `oort connect <host>` to try. |
| `store` | `~/.oort/oort.sqlite` opens, and how many memories are visible from here; how many are in your Planet and in the acting agent's Star (`Planet: 12 memories (every project); Star cursor: 3 memories`); which agent it acts as, where its new memories go, and which agents keep a Star; when the hooks last consolidated the store and when they next will; the embedder its vectors come from matches the configured one; the dense index it searches (`vector-index`, 0.9.0 or newer: `int8, exact`, `binary, 1-bit codes rescored in int8` or `rabitq, ...` with its engine, with the number of searchable vectors and the `store.vectorIndex` setting; a warning when the RaBitQ index runs without its native engine); `~/.oort` is not readable by others. | Does not open: close other oort processes and run `oort stats`. RaBitQ without its native engine: reinstall on a supported platform, or set `store.vectorIndex` to `binary`. Last consolidation failed: `oort consolidate`. Another embedder: `oort reembed`. Readable by others: `chmod 700 ~/.oort`. |
| `relay` | The relay URL in use, and, when a role goes through Oort Pro, whether its `/health` answers within 3 seconds. | An invalid `OORT_RELAY_URL`: unset it. Unreachable (a warning): check your network or proxy. |
| `updates` | From the [update check](#the-update-notice)'s file only (doctor makes no request for it): a newer release, or that this one is the latest. Shown to people only, never in `--json`, and not when the check is off. | A newer release (information): `oort update`. |

Each check has a status: `✓` ok, `!` warn, `✗` fail, `•` info and `?`
unknown. A relay that does not answer `/health` is a warning, not a failure:
Oort still works locally, and recall falls back to lexical-only. A failed check
makes doctor exit 1; warnings alone exit 0, so `oort doctor && …` works on a
keyless or local-only install. With `--json`, `data.status` is `ok`, `warn` or
`fail`.

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

With `--json` its `data` is `{ "status": "ok" | "warn" | "fail", "problems":
number, "checks": [{ "group", "name", "status", "detail", "fix"?,
"fixCommand"? }] }`. `fixCommand` is set where the fix is a command you can run
as it is (`oort connect cursor`, `chmod 600 <file>`, `oort models pull`), also
when `fix` wraps it in a sentence.

## Projects: `oort project`

```sh
oort project link [--id <id>]   # trust this repository's project id
oort project unlink
```

A repository's `oort.config.json` can name a `project.id`. That id is ignored
until you link it, because a cloned repository could otherwise read another
project's memories. See `docs/claude-code.md`.

`record_judgment` and `judge` ([judgment memory](#judgment-memory-oort-judge)) are offered by the
local server only; in cloud mode the server has the other tools.

The derived id comes from the main repository root, resolved the way the
operating system sees it: symlinks followed and the case as stored on disk. A
repository reached through a symlink, or typed with other capitalisation on
macOS, is one project. A worktree whose main checkout was moved or deleted
gets an id of its own until `git worktree repair` reconnects it.

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
