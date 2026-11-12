# Public long-term memory sets: LoCoMo and LongMemEval_S

Retrieval-level runs of two public sets (CON-147), so the memory relationships bar (design
`docs/design/2026-11-12-memory-relationships.md`, section 11) is measured inside Oort's own
harness. Published LoCoMo numbers use different judges, metrics and category labels, so they
do not compare with each other or with these. Scoring here needs no judge: it is recall@k of the
turns that hold each question's evidence.

Neither dataset is bundled. Tests use only the two hand-made samples in this directory
(`locomo-sample.json`, `longmemeval-sample.json`), which are written in each set's format.

## Sources

| Set           | File                         | Pinned revision                                                                                                                                                                      | SHA-256                                                            | Size   | Licence      |
| ------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------ | ------------ |
| LoCoMo        | `locomo10.json`              | [snap-research/locomo@3eb6f2c](https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json)                                   | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | 2.8 MB | CC BY-NC 4.0 |
| LongMemEval_S | `longmemeval_s_cleaned.json` | [xiaowu0162/longmemeval-cleaned@98d7416](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json) | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` | 277 MB | MIT          |

- LoCoMo: Maharana et al., "Evaluating Very Long-Term Conversational Memory of LLM Agents", ACL
  2024 (arXiv:2402.17753). Its licence is
  [CC BY-NC 4.0](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt):
  non-commercial use, with attribution. It is downloaded to the machine that runs the eval and
  never copied into this repository.
- LongMemEval: Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive
  Memory", ICLR 2025 (arXiv:2410.10813). The cleaned release on Hugging Face is MIT.

`--fetch` downloads the pinned revision into `packages/bench/.cache/datasets/` (gitignored) and
refuses a download whose SHA-256 differs. Every run checks the hash again and prints it; a file
that is not the pinned revision runs with a warning.

## Running

```sh
pnpm eval --set locomo --fetch                    # download once, then run lexical-only
pnpm eval --set locomo --embed local --rerank local --home <oort home with pulled models>
pnpm eval --set longmemeval [--limit 100]          # --limit spreads N haystacks through the file
pnpm eval --set longmemeval --embed voyage --rerank voyage --plan   # counts and cost, sends nothing
pnpm eval --set locomo --links grid                # the ablation grid, once recall.links exists (CON-149)
```

Options: `--embed none|fake|local[:model]|voyage[:model]`, `--rerank none|local[:model]|voyage[:model]`,
`--k 5,10`, `--no-gate` (recall's relevance gate off, for comparison), `--links` (as for plain
eval files, `../format.md`), `--json`, `--out <file>` (the JSON report), `--cache-dir <dir>`.

**Paid models.** `--embed voyage` or `--rerank voyage` without `--yes` prints the plan and exits
with code 2, sending nothing. `--plan` prints it and exits 0. The plan counts, exactly, the
distinct turn texts to embed (deduplicated across haystacks, minus those already in the embedding
cache), the requests they take (128 per request) and their characters and tokens; and, as upper
bounds, one query embedding and one rerank call (with that haystack's longest `rerankK`
documents) per question. Tokens are counted with Voyage's published tokenizer when it is in
`packages/bench/.cache/tokenizers/voyage-3.5-lite/` (`tokenizer.json` and `tokenizer_config.json`
from [MongoDB/voyage-3.5-lite@3331232](https://huggingface.co/MongoDB/voyage-3.5-lite); the
rerank-3-lite tokenizer file is identical), else estimated at 4 characters a token and labelled
so. Prices are Voyage's list prices ($0.02 per million tokens for both, 2026-11-12); a free
allowance on the account lowers the real cost.

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
  ids are cleaned of the file's few typos (`D8:6; D9:17`, `D:11:26`); references that name no turn
  are dropped and counted, and a question left with none is left out and counted. Categories
  follow the mapping most published retrieval results use, which the question counts confirm: 1
  multi-hop (282), 2 temporal (321), 3 open-domain (96), 4 single-hop (841), 5 adversarial (446).
  Recall's "now" is a day after the last session.
- **LongMemEval_S**: one haystack per question (500, about 50 sessions each). A memory is one round
  (a user message and the assistant reply after it), the retrieval granularity the LongMemEval
  authors found best; `turnRef` is `<session id>#<round>`, `at` the session's date plus a second
  per round, and recall's "now" the question's date. A round is evidence when either message has
  `has_answer`. Two scores: turn recall@k (rounds) and session recall@k (the sessions of the
  returned rounds against `answer_session_ids`). For `knowledge-update`, the rounds of the latest
  answer session are expected and those of earlier answer sessions count toward stale-leak. The
  30 abstention questions (`_abs` ids) are their own group.

Limits worth knowing:

- This measures retrieval over raw turns. The writer that turns a turn into standalone facts and
  the reconcile step that supersedes an outdated fact are not in the loop, so stale-leak here is
  a baseline to compare links against, not a measure of how Oort handles updates.
- `observe` caps a turn at 32 KB and the local embedder reads the first 512 tokens of it; long
  assistant replies in LongMemEval are cut by both.
- Recall's relevance gate drops weak matches, so recall@10 can be lower than "top 10 of a ranked
  list" would be. `--no-gate` shows the difference.

Baselines are recorded in `../../baselines/`.
