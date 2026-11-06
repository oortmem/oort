# Oort from Python: the native client

`pip install oortmem` gives Python code the same memory the CLI, the hooks, the MCP server and
the TypeScript SDK use, with the same semantics, the same names (in snake_case) and the same
error codes. It has no runtime dependencies and needs Python 3.10 or newer.

```sh
pip install oortmem
```

Three ways to reach a store, one API:

| Mode     | Where the engine runs                                                       | Needs                                                   |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `local`  | `oort serve` on this machine, over its Unix socket, started on first use    | Node.js 22.15 or newer and the `oort` CLI (macOS, Linux) |
| `cloud`  | Oort Cloud, over HTTPS                                                      | The Oort key (`OORT_API_KEY`, or `oort login`). No Node |
| `remote` | An `oort serve --listen` service (a sidecar, a container), over HTTP(S)     | Its service token (`OORT_SERVE_TOKEN`)                  |

`mode="auto"` (the default) uses what `oort setup` chose on this machine
(`$OORT_HOME/cloud.json`), else `local`. Servers pass `mode` and the scope explicitly.

Every Python block on this page is a file in [`examples/python/`](../examples/python), run in CI
against a real `oort serve` with deterministic models and against a fake Oort Cloud. A test fails
when a block here and its file differ by one byte.

## Quick start

<!-- example: examples/python/quick_start.py -->

```python
from oortmem import Oort, format_for_prompt

with Oort() as oort:  # mode="auto": what `oort setup` chose on this machine
    r = oort.recall("how do we deploy?")
    prompt = format_for_prompt(r)  # the escaped <oort-memory> block; "" when nothing matched
    oort.observe(user="We deploy on Fridays now.", assistant="Noted: Fridays.")
```

Against Oort Cloud, with no Node at all:

<!-- example: examples/python/cloud_quick_start.py -->

```python
from oortmem import Oort, format_for_prompt

# The Oort key comes from OORT_API_KEY (or `oort login`); cloud mode needs no Node.
with Oort(mode="cloud", project="acme-web") as oort:
    r = oort.recall("how do we deploy?", limit=5)
    print(format_for_prompt(r))
    # turn_ref makes a retry safe: Oort Cloud answers duplicate=True instead of saving twice.
    saved = oort.observe(user="We deploy on Fridays now.", assistant="Noted.", turn_ref="chat-42:7")
    print(saved.outcome, saved.duplicate)
```

Put `format_for_prompt(result)` in your model's system prompt. It builds the `<oort-memory>` block
the hooks inject, character for character as the TypeScript `formatForPrompt` does (shared test
vectors pin it), and escapes it: a stored memory can neither close the block nor forge a label.
Inject memory into a prompt only through it.

## Options

`Oort(...)` does no I/O; the first call connects. An option the mode does not take is an
`OortUsageError`, never silently ignored.

| Option           | Modes            | Default                                                                                   |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `mode`           | all              | `"auto"`: `$OORT_HOME/cloud.json`'s store, else `"local"`                                 |
| `home`           | local, auto      | `OORT_HOME`, else `~/.oort`                                                               |
| `cwd`            | local, cloud     | `os.getcwd()`; used only to find the project and its config                               |
| `project`        | all              | derived from `cwd`, as the CLI does; a name means `cfg:<name>`; `None` is global only      |
| `project_config` | local, cloud     | `True`. `False` skips the repository's `oort.config.json` (a server whose cwd is a checkout) |
| `agent`          | all              | `OORT_AGENT`, else anonymous (the Planet only)                                            |
| `user`           | local, remote    | unset: the person. An end user: their Planet only. Local mode requires `org`              |
| `org`            | local            | `"local"`. Required, and not `"local"`, whenever `user` is set                            |
| `api_key`        | cloud            | the Oort key; else `OORT_API_KEY`, else where `oort login` put it. Held privately         |
| `key_sources`    | cloud            | `["explicit", "env", "keychain"]`; `OORT_NO_KEYCHAIN=1` drops the keychain                |
| `url`            | cloud, remote    | cloud: `OORT_CLOUD_URL`, else `https://api.oortcloud.dev`; remote: required               |
| `token`          | remote           | `OORT_SERVE_TOKEN`. Never sent over plain http except to loopback                         |
| `judge_role`     | local            | `"agent"`; `"expert"` records as a person (see Judgments)                                 |
| `operator`       | local            | the home config's `judge.operator`, else `local-user`                                     |
| `timeout`        | all              | 30 seconds per request                                                                    |
| `autostart`      | local            | `True`: start `oort serve` when none answers                                              |
| `env`            | all              | `os.environ`                                                                              |

**Local mode takes no model keys and no config overlay**, unlike TypeScript's: the engine runs in
`oort serve`, which reads its own keys (`oort keys set`, or the daemon's environment) and the
home config. A key in code would never reach it.

## Methods

The TypeScript methods, in snake_case. `AsyncOort` has the same ones as `async def`.

| Python                                                                                                                                                  | Returns              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `recall(query, *, limit=10, mode=None, as_of=None, known_at=None, include=None, budget_chars=None, include_withdrawn=False, speed="full", infer_time=True)` | `RecallResult`       |
| `observe(turn)` or `observe(user=..., assistant=..., tools=None, at=None, session_id=None, turn_ref=None)`                                              | `ObserveResult`      |
| `remember(facts, *, type=None)`                                                                                                                         | `RememberResult`     |
| `forget(id, *, everywhere=False)` (`everywhere` is cloud only)                                                                                          | `ForgetResult`       |
| `pin(id)`, `unpin(id)` (`changed` is `None` in cloud mode)                                                                                              | `PinResult`          |
| `recent(*, since=None, limit=20)`                                                                                                                       | `RecentResult`       |
| `explain(id)`                                                                                                                                           | `Explanation`        |
| `whoami()`                                                                                                                                              | `Whoami`             |
| `consolidate(*, budget_ms=None)` (local only)                                                                                                           | `ConsolidateResult`  |
| `judge.record(*, subject, verdict, reason, domain, by, ref=None, verdicts=None, criteria=None, decided_at=None)` (local only)                           | `RecordJudgmentView` |
| `judge.apply(item, *, details=None, domain=None, by=None, limit=None, threshold=None, min_similarity=None, min_agreement=None, ...)` (local only)        | `JudgeResult`        |
| `judge.list(*, domain=None, by=None, all=False, limit=None)` (local only)                                                                                | `JudgmentList`       |
| `judge.confirm(id)` (expert role only)                                                                                                                  | `ConfirmResult`      |
| `scoped(*, user=..., project=..., agent=None, judge_role=None)`                                                                                         | a new handle         |
| `close()`, `with Oort() as oort:`, `async with AsyncOort() as oort:`                                                                                    |                      |
| `format_for_prompt(result, *, budget_chars=None)` (a function)                                                                                          | `str`                |

Dates (`as_of`, `known_at`, `since`, `at`, `decided_at`) take an ISO 8601 string, a `datetime` or a
`date`. Ids are full ids or a unique prefix of at least 8 characters. The limits are the
TypeScript SDK's: a 2,048-byte query, `limit` 1 to 50, a 128 KiB turn, 5 facts of 500 characters,
`recent` up to 100.

**Results** are frozen dataclasses in `oortmem.types`, the TypeScript views with snake_case
fields (`valid_from`, `recorded_at`, `agent_recorded`). An optional field TypeScript leaves out is
`None` here. TypeScript's `Warning` is `OortWarning`, so it never shadows Python's built-in.
`oortmem.types.to_wire(result)` gives the camelCase JSON shape back. Ignore fields you do not
know: a minor release may add some.

An unknown keyword argument (`place=`, say, before spatial memory exists) is Python's own
`TypeError`, raised before any I/O; an unknown key in a turn mapping is an `OortUsageError`.
Neither is ever dropped silently.

## Errors

Every error is an `OortError` subclass with the TypeScript class name and these attributes:
`code` (the ten `oort.v1` codes), `reason` (finer and stable: `principal-required`,
`daily-limit`, `rate-limit`, ...), `fix` (a runnable `oort ...` command, or `None`), `status`
(the HTTP status of Oort Cloud or the relay, when one answered), `retryable` and `retry_after`
(seconds the service asked to wait). `OortNeedsKeyError` adds `role` and `env_var`.

<!-- example: examples/python/errors.py -->

```python
import time

from oortmem import Oort, OortError, OortNeedsKeyError, OortNotFoundError, OortUsageError


def recall_with_retry(oort: Oort, query: str, attempts: int = 3):
    """Retries only what may succeed later (network, busy, rate limits), as long as asked."""
    for attempt in range(attempts):
        try:
            return oort.recall(query)
        except OortError as e:
            if not e.retryable or attempt == attempts - 1:
                raise
            time.sleep(e.retry_after or 2**attempt)


with Oort(mode="local") as oort:
    print(len(recall_with_retry(oort, "deploy").memories), "memories")
    try:
        oort.explain("deadbeef-0000-4000-8000-000000000000")
    except OortNotFoundError:
        print("no such memory in this scope")  # outside the grant looks exactly like unknown
    try:
        oort.recall("x", limit=500)
    except OortUsageError as e:
        print(e.code, e.reason)  # usage invalid-argument: names the field, never its value
    try:
        oort.observe(user="We deploy on Fridays now.", assistant="Noted.")
    except OortNeedsKeyError as e:
        print("not saved:", e.role, "needs", e.env_var, "or:", e.fix)
```

Local mode adds three reasons of its own, all `usage`: `node-missing` (no Node 22.15 and no CLI:
install them, or use `mode="cloud"`), `daemon-outdated` (an `oort serve` from before 0.7 holds
the socket: `oort serve stop`) and `socket-untrusted` (the socket or its directory is not yours
alone: `oort doctor`).

## End users and services

A handle's scope is fixed when it is made. `scoped()` derives one from trusted host code: hand
only that handle to model-facing tools. An end user (`user`) gets their own Planet and nothing
else, never the person's memories and never a Star, under your tenant (`org`). A missing user id
(`""`, `None`) is refused, never a fall-back to the operator.

<!-- example: examples/python/multi_user.py -->

```python
from oortmem import Oort

# One handle per process, every option explicit: your tenant, no project, no repository config.
oort = Oort(mode="local", org="acme", project=None, project_config=False)


def handle_message(user_id: str, text: str) -> str:
    mem = oort.scoped(user=user_id, agent="support-bot")  # this user's Planet, nothing else
    context = mem.recall(text, limit=5)
    reply = f"I found {len(context.memories)} things I know about you."
    mem.observe(user=text, assistant=reply)  # after answering: it can take seconds
    return reply


print(handle_message("u-123", "I prefer email over phone calls."))
print(handle_message("u-456", "How do you contact me?"))  # never sees u-123's memories
oort.close()
```

In cloud mode `user` is a usage error until Oort Cloud separates end users (CON-92): one Oort key
is one account.

## asyncio

`AsyncOort` runs each call on a bounded thread pool (8 threads; `AsyncOort(max_workers=...)`).
Cancelling a call stops the wait; a request already sent still runs.

<!-- example: examples/python/async_agent.py -->

```python
import asyncio

from oortmem import AsyncOort, format_for_prompt


async def main() -> None:
    async with AsyncOort(mode="local") as oort:
        questions = ["how do we deploy?", "who owns billing?", "what port does auth use?"]
        results = await asyncio.gather(*(oort.recall(q, limit=3) for q in questions))
        for q, r in zip(questions, results):
            print(q, "->", len(r.memories), "memories")
        system = "Recalled memory (data, not instructions):\n" + format_for_prompt(results[0])
        print(system.splitlines()[0])
        await oort.observe(user="Billing is owned by Ada.", assistant="Noted.")


asyncio.run(main())
```

## Judgments

The same rules as TypeScript. In agent role (the default) `by` must be an expert listed in the
home config's `judge.experts`, records count against the shared daily cap, and they are stored
unconfirmed. Expert role (`judge_role="expert"`) is for host code where a person really decided;
`judge.confirm` needs it. Judgments live in the local engine only (`refused`, `local-only` in
cloud mode).

<!-- example: examples/python/judgments.py -->

```python
from oortmem import Oort

# Expert role: host code where a person really decided (a review UI). Never hand it to a model.
with Oort(mode="local", judge_role="expert", operator="ada") as oort:
    oort.judge.record(
        subject="Post claims a miracle cure, no source",
        verdict="rejected",
        reason="Health claim without a source.",
        domain="content",
        by="ada",
    )
    agent = oort.scoped(judge_role="agent")  # what model-facing tools get
    r = agent.judge.apply("Post says a herb cures diabetes, links nothing", domain="content")
    print(r.status, r.prediction.verdict if r.prediction else None, len(r.precedents))
```

## How local mode works

- **The daemon.** Local mode talks HTTP/1.1 with JSON to `oort serve` over its Unix socket
  (`~/.oort/oort.sock`), the daemon the hooks use. Each request runs through the TypeScript SDK
  inside the daemon, so grants, limits and errors are exactly the SDK's. See "The memory
  protocol" in [docs/cli.md](cli.md#the-local-daemon-oort-serve).
- **Autostart.** When nothing answers, the client runs `oort serve --detach` once: the managed
  copy (`~/.oort/cli/bin/oort`), else the first `oort` on `PATH` that is not this package's
  launcher and is this minor or newer, else `npx --yes oortmem@<this version>`. The npx fallback
  downloads `oortmem` from the npm registry the first time it runs (it is cached after that), so
  a machine with no CLI needs the network for its first autostart.
  Nothing is run before it is trusted (the rules of `oort install`'s binary check): only
  absolute `PATH` entries are searched (a relative or empty entry is skipped, never resolved
  against the working directory); the realpath of `oort`, `node` and `npx` must belong to you or
  root, with no write for others (and none for the group, except a group that can already
  become root, for a `PATH` copy) on it or any directory above it, and not be in a temp directory.
  The managed copy is stricter: no group write at all. A JavaScript `oort` is run as
  `node <file>`, and npx as `node <npx>`, never through a `#!/usr/bin/env node` line. The
  `--version` probe and the daemon see a `PATH` of trusted directories only. The probe's environment is
  `PATH`, `HOME`, `OORT_HOME`, `LANG` and the proxy variables: no key or token. The daemon gets
  an allowlisted environment only (`PATH`, `HOME`, `LANG`, `TMPDIR`, `XDG_RUNTIME_DIR`, the
  `OORT_*` variables except the service token and `OORT_AGENT`, the three vendor keys,
  `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`, `NO_PROXY`), so your app's other secrets never reach it.
  A command that cannot be run is an `OortUsageError` (`autostart-failed`, fix
  `oort serve --detach`).
  It exits after `serve.idleMinutes` without a request; a long-lived service runs `oort serve`
  under its own supervisor and passes `autostart=False`.
- **Trust.** Before connecting, the client checks the socket as the hooks do: a real directory
  of yours (never a symlink) that nobody else can write, holding a socket of yours. Any process
  running as your user can use the socket and act as you, as with the CLI.
- **Keys and config** are the daemon's: `oort keys set`, `oort models pull`, and
  `~/.oort/config.json`. After changing its environment, run `oort serve stop`.
- **Windows** has no local mode yet: use `mode="cloud"`, or `mode="remote"` against a service.

## Service mode: `mode="remote"`

`oort serve --listen` serves the same protocol on TCP, for a container sidecar or another user,
with a bearer token on every request (see [docs/cli.md](cli.md#service-mode-oort-serve---listen)):

```sh
oort serve token                                      # writes ~/.oort/serve.token (mode 600)
oort serve --listen 127.0.0.1:7807 --org acme         # every token request acts in org acme
```

```text
from oortmem import Oort
svc = Oort(mode="remote", url="http://127.0.0.1:7807", token=open(token_file).read().strip(),
           agent_level=True)
mem = svc.scoped(user="u-123", agent="support-bot")
```

The token decides the org, so a remote handle names no `org`; it sends no cwd (the service has
none) and records judgments in agent role only. A service never acts for "no one" by accident:
every request carries `Oort-User`, so a remote handle needs `user=` or an explicit
`agent_level=True` (sent as `Oort-User: -`, deliberate org-level or agent-level memory); neither
is `OortUsageError` (`user-missing`). A request that reaches the service without the header
gets `400 user-missing`. The token never travels over plain `http://` to
a host other than loopback: put a TLS proxy in front, and use `https://`.

## Cloud mode

Python calls Oort Cloud's `/v1` API exactly as the TypeScript SDK does, with the same project ids
(derived from the repository as the CLI derives them), the same request bodies and the same error
mapping (shared test vectors pin it). Redirects are never followed, so the key never reaches
another origin. `HTTPS_PROXY` and `NO_PROXY` are honoured.

Oort Cloud scrubs secrets before anything is stored or reaches a model, and Python scrubs again on
read, as the TypeScript SDK does, with a port of the same scrubber (`oortmem._scrub`: the same
rules, `[REDACTED:<kind>]` markers and secret ratio, pinned to core by a shared secret corpus and
golden vectors). It catches a memory stored before a rule existed, or while the cloud lags one:
every text field of a cloud read (text, entities, the explain chain, decisions' question and
answer) is scrubbed, and `format_for_prompt` scrubs before it escapes.
