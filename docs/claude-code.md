# Using Oort with Claude Code

`oort setup` installs the hooks below and can also connect the MCP server
(`oort connect claude-code`). Every command and flag is in `docs/cli.md`.

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

## Oort Cloud mode

After `oort cloud use` (Oort Pro), the hooks recall from and save to your Oort Cloud account
instead of `~/.oort/oort.sqlite`. Nothing else changes for Claude Code:

- UserPromptSubmit and SessionStart ask the cloud and inject what it returns. A cloud timeout or
  error injects nothing (the hook log shows `degraded: ["cloud-timeout"]` or `["cloud-error"]`);
  the hook never falls back to the local store.
- SessionStart injects your pinned memories, then the hot tier.
- Stop still only queues turns locally and starts the drain. The drain sends them to the cloud and
  keeps them queued while the account cannot save. Each turn carries a stable `turnRef`, so a retry
  after a crash never saves it twice.
- The hook log keeps counts and timings only, never prompt or memory text.

See `docs/cli.md` for `oort cloud import`, which uploads the memories you already have.

## When Oort injects nothing

Recall abstains when nothing stored answers the prompt. The hook then injects nothing, and the
hook log line has `outcome: "abstained"`. `oort recall` prints "no relevant memories", and the MCP
`recall` tool returns no memories with a note that says so.

The relevance gate, under `recall` in `~/.oort/config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `minRerankScore` | 0.35 | A reranked memory needs at least this Voyage rerank score (0 to 1). Calibrated on 2026-11-04 with real `rerank-3-lite` scores on the demo eval: answerable rows scored 0.767 or more, abstention rows 0.303 or less. Rerun the calibration on your own store to tune it, see below. |
| `minCoverage` | 0.5 | Without a rerank score, a memory needs this share of the prompt's informative words (stopwords and question words do not count). Set from the bench eval fixture. |
| `minDenseScore` | 0.6 | Without a rerank score, a dense similarity this high also lets a memory through, for paraphrases. Provisional. |
| `skipRerankWhenConfident` | true | Skip the rerank call when the top result is clear: it is the lexical top, holds most of the prompt's words, the runner-up is clearly weaker, and it is near the top of the dense search too unless it holds every word. |

Set a threshold to 0 to switch that test off.

To calibrate the provisional thresholds with real scores:

```sh
VOYAGE_API_KEY="$(security find-generic-password -a "$USER" -s oort.voyage -w)" \
  pnpm --filter @oortmem/bench run calibrate
```

With a labelled eval file for your own store it also suggests `minDenseScore`:
`... run calibrate -- --store ~/.oort/oort.sqlite --eval my-eval.jsonl`.

## Hook latency

The `UserPromptSubmit` hook loads only the embed and rerank adapters, so it reads one key and
imports no TypeSafe or Anthropic SDK. Full recall gets 1.5 s before the hook falls back to
lexical-only recall. Each hook log line records `wireMs` (config, store and keys) and the recall
stages (`embedMs`, `lexicalMs`, `denseMs`, `hydrateMs`, `fuseMs`, `rerankMs`), as numbers only, and
counts `embedSkipped` and `rerankSkipped` when recall saved a round trip.

`oort hook <event>` loads only the hook command and the wiring, not the rest of the CLI. The
`Stop` hook reads the transcript from where the previous `Stop` left off: it re-reads the last
pair it processed (to find its cursor) and whatever came after, so its cost per turn does not grow
with the session. Its log line counts `bytesRead`, and `incremental` when it read from a saved
offset. When the file was truncated or rewritten under that offset, it reads the whole transcript
once and counts `offsetStale`. `SessionStart` makes two store queries (hot, then pinned), however
many memories there are.

Most of a recall's time is two calls to Voyage: embedding the prompt and reranking the results.
Three settings under `recall` cut them:

| Key | Default | Meaning |
| --- | --- | --- |
| `lexicalFirst` | true | Run the lexical search first. When its top result holds every informative word of the prompt (at least two of them), is current, and the runner-up holds clearly fewer, the prompt is not embedded at all. |
| `rerankBudgetMs` | 400 | The longest wait for the reranker. Past it, recall uses the fused order, logs `rerank-timeout`, and the relevance gate falls back to word coverage and dense similarity. 0 waits as long as the reranker takes. |
| `queryCacheTtlSec` | 600 | How long a prompt's embedding is reused. The cache is in memory and on disk under `~/.oort/cache/query-embed` (files are named by a SHA-256 hash; no prompt text is stored). 0 turns it off. |

From Europe a warm Voyage rerank took 200 to 300 ms when measured on 2026-11-04, so the 400 ms
default lets normal reranks finish and only cuts off slow outliers. Lower it (150 ms is the spec's
target) to trade rerank quality for latency, or set it to 0 to always wait.

## Consolidation

With hooks alone nothing would ever call `oort consolidate`, so the drain that `Stop` starts runs it
when it is due: a day after the last complete run, or once the drain has saved 200 turns since. It
runs after the drain's own work, over every project and your global memories (each ranked on its
own), in every node Claude Code writes: your Planet and Claude Code's Star, or only the Star when
Claude Code keeps one. Expired and superseded memories reach cold storage there.

- The drain is detached, so a `Stop` never waits for it. A `Stop` with nothing new to queue starts
  the drain anyway when consolidation is due; checking costs one small file read.
- `~/.oort/consolidate.lock` keeps two drains from consolidating at once; a lock older than five
  minutes is from a crashed drain and is broken.
- A run gets 2 s. It evicts 50 memories per store transaction, so a prompt hook never waits long
  for the store. A run cut short keeps what it wrote, and a drain a minute or more later resumes
  it. A run that fails is retried an hour later.
- Every write is atomic and checked against the record it was computed from, so a crash mid-run
  leaves a consistent store and the next run finishes the job.
- Hooks never migrate the store; with a migration pending the drain does nothing.
- In cloud mode the drain does not consolidate: Oort Cloud does that itself.

`~/.oort/consolidate.json` records the last run (times and counts only). `oort doctor` shows when it
last ran and when it is next due, `oort stats` shows when the store was last consolidated, and the
hook log has one `consolidate` line per run (`ok`, `partial`, `locked` or `error`). A manual
`oort consolidate` counts as that day's run.

## Phase 1 baseline (dogfood, 2026-11-04)

First real run, on an Apple Silicon laptop under heavy load (load average 50 to
150 from other work running at the same time). Keys from the Keychain.

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
  most of it is two network calls. Addressed by CON-57 (see Hook latency);
  re-measure on the next dogfood run.
- 13% unwritable: the writer should be able to return more than one memory
  per observation instead of overflowing one. Addressed by CON-56 (below);
  the share after the change needs a re-run of the import.
- The superseded share (69%) is high; check that status updates are not
  superseding unrelated facts. Addressed by CON-56 (below); re-measure with the
  same re-run.

## One turn, several memories (CON-56)

The writer splits a turn into 1 to `writer.maxMemoriesPerObservation` memories
(default 5), one fact each, each under the old limits (text up to 600
characters). A turn with one long fact is split rather than skipped. A turn is
`unwritable` only when the writer's answer fails twice, now with the split.

Each memory is then handled on its own:

1. One embed call covers every memory of the turn. Each memory stores the
   embedding of its own text, not the whole turn's.
2. Related memories are looked up per memory, all before anything from the
   turn is stored, so two facts from one turn never replace each other.
3. Jev judges each memory against its own related memories. Through the Jev
   adapter this is one call for the whole turn (`reconcileMany`), split only if
   the request would pass the relay's size limit.
4. A memory whose related memories are all unrelated is added as new. A prior
   memory is ended by at most one memory of the turn.

Calls per stored turn: one gate call, one writer call (two on a retry), one
embed call with up to 5 inputs, and one reconcile call. Before, it was the
same, with one embed input. Through Oort Pro, embed inputs count toward the
monthly embed allowance, so a split turn uses up to 5.

`oort import` counts each memory: its summary and the eval file show one entry
per memory, not per turn. `oort observe` lists them under `memories`.

## Facts that change over time (CON-34, CON-49)

Jev answers one question per related memory, as before, now with six choices: unrelated,
reinforce, refine (same fact, more detail), supersede (the situation changed), correct (the old
fact was never right) and add. The call count does not change: one reconcile call per turn
(`reconcileMany` on the split path), and the gate gains one question (`volatile`).

| Jev's choice | What happens to the old memory | Outcome |
| --- | --- | --- |
| refine | Rewritten in place; its earlier text is kept in its decisions (`refine` / `previous-text`). | `updated` |
| supersede | Closed at the new fact's start: `validTo` and `endReason: superseded`. A fact that starts later ("starting next week") leaves the old one current until then. | `superseded` |
| correct | Retracted: `expiredAt` (now) and `endReason: corrected`. The correction takes its valid interval. | `corrected` |

A turn can still arrive late (an import, a queued drain): an older fact closes itself in front of
the newer one instead of ending it.

Dates are resolved in code, never by the writer model. "Until Friday", "starting next week" and
"since last Monday" in a written fact set its `validFrom` and `validTo`, read against the turn's
own time (see [Time](cli.md#time-recall-modes) for each cue). When the turn says "yesterday" and
the writer's day is one or two off, it is fixed; a date the user stated is never rewritten. Both
are logged as `temporal` / `writer-date`.

A refine rewrites the memory in place, records the refining turn, and appends only that turn's own
decisions. A cold memory that is refined moves back to warm.

The prompt hook reads the time mode from the prompt (see [Time](cli.md#time-recall-modes)): "what
port did we use in March" gets what was true then, and a history question ("how has the build
changed?") gets every version, oldest first. An ordinary instruction that mentions a change ("fix
the test, the config changed") stays current. In the injected block a version that is no longer current shows its interval instead
of its age:

```text
<oort-memory>
- [semantic, 2026-03-01 to 2026-05-01] auth-service listens on port 3000 in local development.
- [semantic, 3mo ago] auth-service listens on port 8080 in local development.
- [episodic, 2mo ago] Release 1.3 is blocked on the auth migration. (may be outdated; last confirmed 2mo ago)
</oort-memory>
```

The last line is a volatile fact (a status, a current version, an owner) that nobody confirmed
within `recall.staleAfterDays` (default 30). `oort revalidate` lists them; confirming one in a
session clears the note.
