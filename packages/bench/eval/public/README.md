# Public long-term memory sets: LoCoMo and LongMemEval_S

Retrieval-level runs of two public sets (CON-147), so the memory relationships bar (design
`docs/design/2026-11-12-memory-relationships.md`, section 11) is measured inside Oort's own
harness. Published LoCoMo numbers use different judges, metrics and category labels, so they
do not compare with each other or with these. Scoring here needs no judge: it is recall@k of the
turns that hold each question's evidence.

Neither dataset is bundled. Tests use only the two hand-made samples in this directory
(`locomo-sample.json`, `longmemeval-sample.json`), which are written in each set's format.

**LongMemEval_S is the public set; LoCoMo is local only.** LoCoMo's licence is non-commercial
(CC BY-NC 4.0), so Oort publishes no LoCoMo numbers: not in this repository, its baselines, PRs,
docs or the website. The adapter stays so anyone can run it on their own machine for their own
comparison.

## Sources

| Set           | File                         | Pinned revision                                                                                                                                                                      | SHA-256                                                            | Size   | Licence      |
| ------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------ | ------------ |
| LoCoMo        | `locomo10.json`              | [snap-research/locomo@3eb6f2c](https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json)                                   | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | 2.8 MB | CC BY-NC 4.0 |
| LongMemEval_S | `longmemeval_s_cleaned.json` | [xiaowu0162/longmemeval-cleaned@98d7416](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json) | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` | 277 MB | MIT          |

- LoCoMo: Maharana et al., "Evaluating Very Long-Term Conversational Memory of LLM Agents", ACL
  2024 (arXiv:2402.17753). Its licence is
  [CC BY-NC 4.0](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt):
  non-commercial use, with attribution. It is downloaded to the machine that runs the eval and
  never copied into this repository. Run it locally only, and publish no numbers from it.
- LongMemEval: Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive
  Memory", ICLR 2025 (arXiv:2410.10813). The cleaned release on Hugging Face is MIT.

`--fetch` downloads the pinned revision into `packages/bench/.cache/datasets/` (gitignored),
streaming it and stopping if it runs past the recorded size, and keeps it only when its SHA-256
matches. Every run checks the hash again, before the file is read, and prints it. A file that is
not the pinned revision is refused (exit 1), and so is a file given by path, unless the run says
`--unpinned`; such a run is recorded with `"pinned": false`.

## Running

```sh
pnpm eval --set longmemeval --fetch               # download once, then run lexical-only
pnpm eval --set longmemeval --embed local --home <oort home with pulled models>
pnpm eval --set longmemeval --limit 50             # --limit spreads N haystacks through the file
pnpm eval --set longmemeval --embed voyage --rerank voyage --plan   # counts and cost, sends nothing
pnpm eval --set longmemeval --links grid           # the ablation grid, over the link kinds recall follows
pnpm eval --set longmemeval --links off,all --speed grid --out lme.json
                                                   # each links mode with and without the reranker;
                                                   # per-question lines in lme.questions.jsonl
pnpm eval compare lme.questions.jsonl lme.questions.jsonl --run-a links=off,speed=full --run-b links=all,speed=full
pnpm eval --set locomo --fetch                     # local only: publish no LoCoMo numbers
pnpm eval --set longmemeval ./other.json --unpinned  # a file by path, recorded as unpinned
```

Options: `--embed none|fake|local[:model]|voyage[:model]`, `--rerank none|local[:model]|voyage[:model]`,
`--k 5,10`, `--no-gate` (recall's relevance gate off, for comparison), `--links` (as for plain
eval files, `../format.md`), `--speed full|fast|grid`, `--entities none|writer[:model]`, `--json`,
`--out <file>` (the JSON report, with the per-question lines beside it), `--questions <file>`
(the per-question lines elsewhere), `--cache-dir <dir>`.

**Runs.** Every links mode runs at every speed (`--links off,all --speed grid` is four runs), each
with its own table and its own per-question lines, labelled `links=<mode>,speed=<speed>`.

- `--speed full` (the default) reranks when `--rerank` names a reranker, as `oort recall` and MCP
  do. `--speed fast` leaves the reranker out, as the prompt hook does in its default
  `recall.promptMode` `fast`, so that ranking is measured too. The hook in `fast` mode also
  follows no links, so `--speed fast --links off` is the ranking it gives today; `fast` with links
  on shows what following links without a rerank would do. A fast run sends no rerank call, and
  with the embedding cache warm it sends nothing at all.
- `--entities none` (the default, as every earlier run) stores each turn with no entities, so the
  `about` links (memories that name the same entity) never form and only same-session links can.
  `--entities writer[:model]` asks the memory writer, the model a normal write names entities with
  (`@oortmem/writer`, default model `writer.model`), for each turn's entities; the stored text is
  still the turn's own words. It is a paid model call per distinct turn text: it prints a plan and
  needs `--yes` like the paid embedder, reads `ANTHROPIC_API_KEY`, and caches its answers by model,
  writer prompt and text in `packages/bench/.cache/entities/<model>.sqlite`, so later runs call it
  for nothing it has seen, and a changed writer prompt starts afresh. A turn whose call fails is
  stored without entities and counted (`entityUsage` in the report); the run stops when more than
  10 calls, and more than 1% of them, fail, after the calls already in flight finish. In cache
  file names, any character of a model name other than letters, digits, `_`, `.` and `-` becomes
  `_`, and an empty model name (`--entities writer:`) is refused, as it is for `--embed` and
  `--rerank`.

**Per-question results and `compare`.** With `--out <file>.json` each run's per-question lines go to
`<file>.questions.jsonl`: the question id and type, the rank of every expected round and answer
session (and of the outdated ones for `knowledge-update`), and the question's share of each
metric. `pnpm eval compare` reads two such files and prints, per metric and question type, the
paired difference with a seeded 95% bootstrap interval and an exact sign test (`../format.md`).

**Paid models.** `--embed voyage` or `--rerank voyage` without `--yes` prints the plan and exits
with code 2, sending nothing. `--plan` prints it and exits 0. The plan counts, exactly, the
distinct turn texts to embed (deduplicated across haystacks, minus those already in the embedding
cache), the requests they take (128 per request) and their characters and tokens; and, as upper
bounds, one query embedding per question and one rerank call (with that haystack's longest
`rerankK` documents) per question for each run that reranks. With `--entities writer` it also
counts the writer calls (one per distinct turn text not in the entity cache) and their characters,
with tokens estimated at 4 characters each; those are not priced here. Tokens are counted with Voyage's published tokenizer when it is in
`packages/bench/.cache/tokenizers/voyage-3.5-lite/` (`tokenizer.json` and `tokenizer_config.json`
from [MongoDB/voyage-3.5-lite@3331232](https://huggingface.co/MongoDB/voyage-3.5-lite); the
rerank-3-lite tokenizer file is identical), else estimated at 4 characters a token and labelled
so. Prices are Voyage's list prices ($0.02 per million tokens for both, 2026-11-12).

**Embedding cache.** Local and Voyage embeddings are kept in
`packages/bench/.cache/embeddings/<model>-512.sqlite`, keyed by model, kind and text, so a second
run (links on, after links off) embeds nothing again. Turn texts are embedded in batches before
the turns are observed.

## What is measured

Each set is read into haystacks: the dialogue one store holds and the questions asked of it. A
fresh SQLite store per haystack; every turn goes through `observe` with a verbatim controller and
writer (`src/verbatim.ts`: every turn stored, as a new memory, in its own words, no model call),
so one turn is one memory and its `turnRef` names the turn. Then each question goes through
`recall` (today's defaults: relevance gate on, `returnK` 10), with access recording and hydration
off so questions do not influence each other, and the returned memories are mapped back to turns.

- **LoCoMo**: one haystack per conversation (10). A turn is one utterance: the speaker's name and
  text, plus `[shares an image: <caption>]` when they shared one; `at` is the session's date plus
  a second per turn (the file has no zone: UTC); `turnRef` is the dialogue id (`D3:7`). Evidence
  ids are cleaned of the file's few typos (`D8:6; D9:17`, `D:11:26`, `D30:05`); references that
  name no turn are dropped and counted, and a question left with none is left out and counted.
  Categories follow the mapping most published retrieval results use, which the question counts
  in the file confirm: 1 multi-hop (282), 2 temporal (321), 3 open-domain (96), 4 single-hop
  (841), 5 adversarial (446). Recall's "now" is a day after the last session.
- **LongMemEval_S**: one haystack per question (500, about 50 sessions each). A memory is one round
  (a user message and the assistant reply after it), the retrieval granularity the LongMemEval
  authors found best; `turnRef` is `<session id>#<round>`, `at` the session's date plus a second
  per round, and recall's "now" the question's date. A round is evidence when either message has
  `has_answer`. Two scores: turn recall@k (rounds) and session recall@k (the sessions of the top
  k returned rounds against `answer_session_ids`). For `knowledge-update`, one answer session
  and its rounds are expected and the other counts toward stale-leak, at both levels: the later
  one is expected unless the question asks otherwise (see below). The 30 abstention questions
  (`_abs` ids) are their own group.

### Stale above current (`knowledge-update`)

Stale-leak counts a question when an outdated answer comes back at all. Verbatim storage never
supersedes, so both answers are in the store and returning both is right; stale-leak here mostly
measures the harness. **Stale above current** asks what matters: does the outdated answer rank
above the current one (best round against best round, or session against session, in the top 10)?
A question where only the outdated answer comes back counts; one where neither does, does not.

### Which knowledge-update answer is current

The file does not mark which answer session holds the value a question asks for.
`answer_session_ids` lists both (70 of the 72 `knowledge-update` questions in the pinned revision
have two answer sessions with `has_answer` rounds), and the only order between them is the
sessions' dates. The adapter takes the later session as current. Reading the question, the answer
and both sessions of all 70 showed where that is wrong, and those questions are relabelled
(`KNOWLEDGE_UPDATE_OVERRIDES` in `src/longmemeval.ts`, each with its reason; a test checks the
table against the pinned file when it is in the cache):

- 8 ask for the earlier value ("What was my previous ...", "before I got ..."). The earlier
  session is expected and the later one counts as stale.
- 8 are scored for recall only, with every answer session expected and no stale label, so they
  count toward neither stale-leak nor stale above current: 5 ask for both values or how the value
  changed ("did I switch to more or less ..."), 1 can be answered from either session, 1 has an
  answer that adds the two sessions up, and 1 has its dates the wrong way round (the session with
  the update is dated before the one it updates).

That leaves 62 questions with a stale label. Recall, stale-leak and stale above current all use
these labels.

**The knowledge-update baseline moved.** Runs before this relabelling took the later session as
current for all 70 questions, so on the earlier-value questions they expected the wrong session
and counted the right one as stale, and on the recall-only ones they counted a session the
question needs as stale. Knowledge-update recall, stale-leak and stale above current (and the
overall totals that include them) from earlier runs, including the recorded baselines, are not
comparable with runs since; rerun both sides before comparing.

Limits worth knowing:

- This measures retrieval over raw turns. The writer that turns a turn into standalone facts and
  the reconcile step that supersedes an outdated fact are not in the loop (`--entities writer`
  takes only the writer's entities), so stale-leak here is a baseline to compare links against,
  not a measure of how Oort handles updates.
- `observe` caps a turn at 32 KB and the local embedder reads the first 512 tokens of it; long
  assistant replies in LongMemEval are cut by both.
- Recall's relevance gate drops weak matches, so recall@10 can be lower than "top 10 of a ranked
  list" would be. `--no-gate` shows the difference.

Baselines are recorded in `../../baselines/`.
