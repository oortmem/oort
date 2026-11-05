# Local decisions (CON-16)

Saving a memory takes two model calls: the **writer** turns a turn into short facts
(`@oortmem/writer`, Anthropic), and the **decider** answers typed questions about it
(`@oortmem/decide-jev`, TypeSafe Jev): is it worth storing, how salient, which type, is it
volatile, and for each fact against each related memory, add, reinforce, refine, supersede or
correct. `@oortmem/local-models` now has a local decider, `localDecider`, that answers the same
questions on the CPU. This page records what was measured and why it ships the way it does.

## What ships

- `localDecider` (a `DecisionController`), selected with `"decide": { "provider": "local" }`,
  which `oort models pull qwen2.5-1.5b-instruct` writes. The config names no decision model:
  the downloaded one is used (`decideModelId`). Nothing is downloaded outside `oort models pull`.
- It answers every question with one word (yes or no, a salience level, a type), read from the
  next-token distribution in one forward pass per question: nothing is generated, so answers are
  deterministic. Each answer's probability sums its case and leading-space variants ("yes",
  "Yes", " yes"), then a per-model bias in log-odds (`calibration` in the catalog entry) corrects
  the model's lean towards yes or no.
- The text questions share is computed once: the system prompt once per process, the exchange
  once per turn, the memory and observation pair once per candidate. Each question then adds
  only its own 20 to 40 tokens on that key/value cache.
- **It never rewrites or ends a memory.** By default reconcile asks one question per candidate
  (is the observation about the same thing?) and answers NOOP or ADD. A fact that changes,
  corrects or refines a memory is stored beside it, not over it. `allowRewrites: true` asks the
  whole tree (below) and guards rewrites under 0.5, for experiments only.
- **There is no local writer.** With a local decider and no writer key, the drain leaves the
  queue as it is, exactly as with no keys at all (tested). The local decider is useful with an
  Anthropic key but no TypeSafe key.
- `oort setup --keys local` offers it after the small models (interactive only; `--yes` prints
  the command). `oort doctor` names it on the `decide` row.

## Candidate models

All Apache-2.0 (commercial use allowed), all from `onnx-community` exports pinned by commit and
SHA-256. Measured on an Apple M1 Max, 4 intra-op threads, **while the machine ran at a load
average of 130 to 220** (other builds and an emulator); absolute times are several times what an
idle laptop shows, the ratios between models hold.

| Model | File | Size | Load | Prefill | Gate signal | Reconcile signal |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen3-0.6B | int4 (genai, MatMulNBits) | 525 MB | 4.0 to 5.7 s | 90 to 250 tok/s | none: "yes" to everything (store AUC 0.53) | none (AUC 0.3 to 0.8, all answers saturated) |
| Qwen3-0.6B | int8 | 618 MB | 3.8 s | 70 to 90 tok/s | not run further | |
| Qwen2.5-0.5B-Instruct | int8 | 512 MB | | | unusable: int8 quantises activations per run, so a prompt split over the cache gives other logits than the whole prompt (up to 6 logits apart) | |
| Qwen3-1.7B | int4 (genai) | 1.4 GB | 17.6 s | 44 tok/s | store 75%, volatile 71% (6-way prompts) | 6-way choice: 21% |
| **Qwen2.5-1.5B-Instruct** | **q4 (MatMulNBits)** | **1.8 GB** | **15 s** | **49 tok/s** | **store AUC 0.82, volatile 0.96** | related 0.97, conflict 0.82, mistake 0.81, samefact 0.89, newinfo 0.31 |

Weight-only int4 (MatMulNBits) gives the same logits with or without the cache (tested on the
real model and in CI on a tiny fixture); dynamic int8 does not, which rules out the int8 exports
for cached prompts. CON-16 proposed Qwen3-0.6B and a 12 ms budget: the 0.6B model cannot tell a
worth-storing turn from "ok thanks", and no model in this class runs a question in 12 ms on a
CPU. Llama 3.2 1B (gated, Llama licence) and Gemma (Gemma terms) were not considered for a
public Apache-2.0 package; Phi-3.5/4-mini (3.8B) are too large for a hook process.

## How the questions are asked

Two prompt styles were compared on Qwen3-0.6B and 1.7B: the six reconcile actions as one lettered
or one-word choice, and a tree of yes-or-no questions. One six-way choice failed at every size
(the model picks one letter for every row: 17 to 31%). The tree:

1. `related`: same specific thing? No: NOOP.
2. `conflict`: they disagree, both cannot be true now? Yes: 3, no: 4.
3. `mistake`: the memory was never right? Yes: CORRECT, no: SUPERSEDE.
4. `newinfo`: adds information? No: REINFORCE.
5. `samefact`: more detail on the same fact? Yes: REFINE, no: ADD.

The six probabilities are the products along the branches. Even calibrated, the 1.5B model's
tree gets 26 of 48 reconcile rows right in sample and 17 of 48 leave-one-out, and 11 of the 24
rows whose memory must stay come out as a rewrite. Ranked by "end this memory" score, the
highest-scoring row is a REINFORCE: there is no threshold at which local supersedes are safe.
`related` alone is reliable (AUC 0.97), which is what the default asks.

## Eval

`pnpm eval --decisions` puts the labelled questions in `packages/bench/eval/decisions.jsonl`
(40 gate turns, 48 reconcile pairs, 8 per action, 8 novel facts) to each decider:

```sh
pnpm eval --decisions --decider local,jev,keyless [--home <dir>] [--rewrites] [--json]
pnpm eval --decisions --fit [--home <dir>]   # fits a decision model's calibration
```

The recall rows of `pnpm eval --demo` (knowledge-update 1.00 among them) are seeded directly into
the store, so they do not depend on the decider; this fixture is where deciders are compared.
`wrong end` counts rows whose memory must stay (NOOP, REINFORCE, ADD) answered SUPERSEDE or
CORRECT: the error that loses a true memory.

Final run, calibration fitted with `--fit` (load average 30 to 45):

| Question | local, default | local, `--rewrites` | keyless (today) |
| --- | --- | --- | --- |
| gate: should store | 85% (34/40) | 85% (34/40) | 40% (16/40) |
| gate: turns not worth storing kept out | 69% (11/16) | 69% (11/16) | 100% (16/16) |
| gate: turns worth storing stored | 96% (23/24) | 96% (23/24) | 0% (0/24) |
| gate: type (argmax) | 21% (5/24) | 21% (5/24) | - |
| gate: volatile | 92% (22/24) | 92% (22/24) | - |
| reconcile: overall | 29% (14/48) | 44% (21/48) | - |
| reconcile: NOOP | 88% (7/8) | 88% (7/8) | - |
| reconcile: REINFORCE | 0% (0/8) | 0% (0/8) | - |
| reconcile: REFINE | 0% (0/8) | 25% (2/8) | - |
| reconcile: SUPERSEDE | 0% (0/8) | 13% (1/8) | - |
| reconcile: CORRECT | 0% (0/8) | 88% (7/8) | - |
| reconcile: ADD | 88% (7/8) | 50% (4/8) | - |
| wrong rewrite (lower is better) | **0% (0/24)** | 17% (4/24) | - |
| wrong end of a true memory (lower is better) | **0% (0/24)** | 17% (4/24) | - |
| missed rewrite (lower is better) | 100% (24/24) | 33% (8/24) | - |
| novel fact (no candidates) | 75% (6/8) | 75% (6/8) | - |
| gate, ms per turn, p50 / p95 | 4,257 / 6,004 | 4,440 / 6,627 | 0 |
| reconcile, ms per pair, p50 / p95 | 1,472 / 1,820 | 3,335 / 7,719 | 0 |

"keyless (today)" is what Oort does with no decider: nothing is stored, so every turn not worth
storing is "kept out" and every other one is lost. With rewrites on, 4 of 24 memories that must
stay would be superseded or corrected (3 REINFORCE rows became SUPERSEDE): that is why the
default never rewrites.

`--fit` per question (rows, right at 0.5 with no bias, fitted, leave-one-out): should_store 40,
24, 34, 33; volatile 24, 18, 22, 20; related 48, 17, 46, 44; conflict 40, 29, 30, 22; mistake 16,
9, 14, 12; newinfo 24, 16, 16, 16; samefact 16, 12, 14, 12; novel 8, 5, 6, 5. Without the bias
the model says yes to nearly everything (related: 17 of 48).

Jev was not measured here: no `TYPESAFE_API_KEY` was set in this environment (keys in the
keychain were not read). `pnpm eval --decisions --decider jev,local` with the key set adds its
column; Jev's own calibration is in decide-jev.

Notes on the local column:

- The calibration is fitted on the same 96 rows it is scored on; the leave-one-out figures from
  `--fit` are the honest ones for unseen turns. A labelled set from real imported transcripts
  (CON-14) should replace this fixture before anyone tunes further.
- The type is a single four-way question and is weak (the writer sets each memory's type in the
  multi-fact path, so the gate's type is only recorded).
- Reconcile accuracy is low by construction: every same-subject pair becomes ADD. The price is
  duplicates and stale facts kept beside their replacement (recall can show both), never a lost
  memory.

## Latency in the drain

Writes happen in the detached drain (`oort hook drain`, spawned by the Stop hook), never in
`UserPromptSubmit`. One drain process loads the model once and handles every queued turn.

One drain process (`node`, new process, model already pulled), one realistic turn (two facts,
two tool summaries) through the gate, then three facts against three candidates each
(`reconcileMany`, 9 pairs), default policy, measured twice at a load average of about 30:

| | Run 1 | Run 2 |
| --- | --- | --- |
| load (ONNX session and tokenizer) | 12.4 s | 10.7 s |
| gate (exchange plus 4 questions) | 7.3 s | 6.6 s |
| reconcile, 9 pairs | 14.6 s | 14.0 s |
| total wall | 34.5 s | 31.5 s |
| CPU time | 73.9 s | 72.7 s |
| forward passes / tokens | 25 / 1,496 | 25 / 1,496 |
| resident memory | 2.4 GB | 3.4 GB |

That is far above the few hundred milliseconds per decision the drain can absorb: about 1.5 s
per reconcile pair and 4 to 7 s per gate here. An idle M1 is several times faster, which is still
seconds per turn and over a minute of CPU per busy drain, plus 2 to 3 GB of memory while it runs.
The user's own work competes for that CPU, which is the main reason the model is opt-in and
never loaded by a prompt hook. The gate also said 0.36 (do not store) for the turn above, which
held two facts: one sample, but a sign that the fitted bias leans towards "no" outside the
fixture.

## No local writer

Generation on the same 1.5B model: 1.5 to 2.8 s of prefill for a 120 to 140-token prompt, then
5.5 to 7.4 tokens per second. A real turn (1,000 to 3,000 tokens) and three facts of 20 to 30
tokens each would take 30 s to a minute per turn here. The output was also not good enough: it
copied the assistant's restatements as facts, kept "last week" instead of a date, and did not
produce the stub, entities and type the writer must return. Writes stay keyless-safe: with no
writer the queue waits.

## Open decisions

1. Ship the 1.8 GB decider at all? It saves only with an Anthropic key, decides only
   store-or-not and add-or-not, and costs about 30 s and 70 s of CPU per drain on this machine.
   My recommendation: merge it as opt-in (it is never pulled by default), and do not advertise it
   in setup beyond the one optional question until a smaller model clears the eval.
2. Add `decide.model` to the core config (one optional field) instead of "the downloaded one".
   Left out here to keep `packages/core` untouched.
3. A labelled set from real transcripts (CON-14) to replace the hand-written fixture, and Jev's
   column on it, before the thresholds are tuned again.
4. A larger model for `oort mcp` (long-lived, so the load is paid once) with `allowRewrites`, if
   one is found that keeps wrong ends at zero.
