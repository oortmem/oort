# Multilingual eval

Recall quality in 12 languages against English (CON-110; design: `docs/design/2026-11-06-multilingual.md`, §11).

> **Native-speaker review needed.** Every non-English memory and question here was written by
> Claude (Opus 5.5), not by native speakers, and not by a translation API. Each was written to read as a
> developer in that language would write it, with identifiers kept verbatim. Before any number here
> gates a release, a native speaker should review at least 10% of each language, and all of
> Japanese and Chinese (design §11). Notes on the choices made are under "Review notes" below.

## Languages

- **Gating (6 plus English):** Spanish `es`, Brazilian Portuguese `pt-BR`, German `de`, French `fr`,
  Japanese `ja`, Simplified Chinese `zh-Hans`.
- **Tracked (6):** Korean `ko` (Hangul), Hindi `hi` (Devanagari, combining marks), Arabic `ar`
  (right to left), Thai `th` (unsegmented), Russian `ru` (Cyrillic), Indonesian `id`.

## Files

| File                     | What                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `facts.jsonl`            | 60 facts' language-neutral metadata: type, entities, `validFrom`, and `supersedes` for knowledge updates |
| `<lang>.corpus.jsonl`    | `{"fact", "text"}`: each fact as a memory in that language                                               |
| `<lang>.questions.jsonl` | Eval rows (`eval/format.md`) with `lang`; ids are `<lang>-<fact>`, such as `pt-BR-u03a`                  |
| `baseline-lexical.json`  | The lexical-only result, checked by `src/multilingual.test.ts` on every run                              |

The 60 facts are 40 single facts (services, ports, owners, procedures, decisions and preferences of a
fictional product team) and 10 knowledge updates, each an older and a newer version. The service
names are chosen not to collide with the synthetic generator's, so the distractors in `mixed` are
noise, not competing answers. Each language has 34 questions, in the same order as English:

| Category         | Rows | Notes                                                                |
| ---------------- | ---- | -------------------------------------------------------------------- |
| single-fact      | 20   | Paraphrased, in chat register, never the memory's wording            |
| knowledge-update | 7    | The newer version expected; the older one in `notExpectedMemoryIds`  |
| temporal         | 3    | Asked with `asOf` and a local time phrase ("en mayo", "5月の時点で") |
| abstention       | 4    | Nothing in the store answers                                         |

The design asks for 120 facts and about 60 questions per language. This first set is half that, so
one question moves a language's recall by about 3 points: compare runs, not single numbers.

## Conditions

- **mono**: questions in a language against that language's 60 memories.
- **cross**: the same questions against the English memories, each expected id mapped to its English
  twin. Every question is therefore also a cross-lingual question (design §11's `cross-lingual` rows).
- **mixed**: all 13 corpora (780 memories) plus the 1,500-memory synthetic English store, in one
  store. A question scores a hit for any language's copy of its fact. The report adds the share of
  found facts whose first copy was in the question's language (language-cluster bias, design §4.4).

The mono store is small (60 memories), so recall@10 is easy to reach there; MRR@10 and the mixed
condition separate the configurations better.

## Running

```sh
pnpm eval --set multilingual                              # lexical only (deterministic, also in CI)
pnpm eval --set multilingual --embed fake                 # plus the bench's fake embedder
pnpm eval --set multilingual --embed local --home <dir>   # bge-small-en-v1.5, already pulled into <dir>
pnpm eval --set multilingual --embed local --rerank local --home <dir>   # plus ms-marco-MiniLM
pnpm eval --set multilingual --lang ja,zh-Hans --condition mono --json --out result.json
```

`local` reads models from `<dir>/models` (default `$OORT_HOME`) and never downloads; pull them with
`oort models pull` first. The reranker is given as long as it takes (`rerankBudgetMs` 0) so runs
repeat. Everything else is recall's default configuration, with the relevance gate on.

**Vendor models.** The cloud's models need `VOYAGE_API_KEY` and are run by hand:

```sh
VOYAGE_API_KEY=… pnpm eval --set multilingual --embed voyage --rerank voyage --out voyage.json
# a specific model: --embed voyage:voyage-3.5-lite --rerank voyage:rerank-3-lite
```

That run answers the design's main open question (is `voyage-3.5-lite` good enough per language?)
and calibrates the cross-lingual `minDenseScore` (design §4.3). It embeds about 3,100 memories and 1,300
questions, and makes at most one rerank call per question and condition. The first run is below
("Voyage, 2026-11-08").

`src/multilingual.test.ts` runs the lexical condition set and compares it with
`baseline-lexical.json`. A tokeniser change shows up there as a changed number;
`OORT_UPDATE_GOLDEN=1` rewrites it, which is only right for an intended change, with the tables
below updated in the same commit.

## Voyage, 2026-11-08

The cloud's default models, `voyage-3.5-lite` (512 dimensions, int8) and `rerank-3-lite`, at oortmem
0.7.0 (`496d4aa`), run from Europe. Two runs: with rerank (MCP and SDK recall) and with `--rerank none`
(the cloud prompt hook's default `fast` mode). The full results are `results-voyage-rerank.json` and
`results-voyage-norerank.json`. The set is not native-reviewed yet, and 4 abstention rows per
language means one row moves abstention FP by 0.25: read these as directions, not release numbers.

| Language | mono R@10, rerank / none | cross R@10, rerank / none | mixed R@10, rerank / none | Abstain FP (mono), rerank / none |
| -------- | ------------------------ | ------------------------- | ------------------------- | -------------------------------- |
| en       | 0.967 / 0.933            | —                         | 0.967 / 0.967             | 0.50 / 0.25                      |
| es       | 1.000 / 0.933            | 1.000 / 0.733             | 1.000 / 0.933             | 0.75 / 0.25                      |
| pt-BR    | 1.000 / 0.967            | 1.000 / 0.900             | 1.000 / 0.967             | 0.75 / 0.25                      |
| de       | 1.000 / 0.933            | 1.000 / 0.600             | 1.000 / 0.967             | 0.75 / 0.00                      |
| fr       | 1.000 / 0.900            | 1.000 / 0.767             | 1.000 / 0.900             | 0.75 / 0.25                      |
| ja       | 1.000 / 0.833            | 1.000 / 0.733             | 1.000 / 0.867             | 1.00 / 0.00                      |
| zh-Hans  | 1.000 / 0.933            | 1.000 / 0.800             | 1.000 / 0.933             | 0.75 / 0.00                      |
| ko       | 1.000 / 0.833            | 1.000 / 0.433             | 1.000 / 0.867             | 0.75 / 0.00                      |
| hi       | 1.000 / 0.900            | 1.000 / 0.800             | 1.000 / 0.933             | 0.50 / 0.25                      |
| ar       | 1.000 / 0.933            | 1.000 / 0.767             | 1.000 / 0.933             | 0.75 / 0.00                      |
| th       | 1.000 / 0.733            | 1.000 / 0.433             | 1.000 / 0.767             | 0.50 / 0.00                      |
| ru       | 1.000 / 0.833            | 1.000 / 0.600             | 1.000 / 0.867             | 0.75 / 0.25                      |
| id       | 1.000 / 0.900            | 1.000 / 0.833             | 1.000 / 0.900             | 0.75 / 0.25                      |

- **With rerank, recall holds everywhere:** recall@10 is 1.000 in every language and condition,
  including cross-lingual (question in one language, memory in English).
- **Without rerank, cross-lingual recall drops** below the design's bar (0.75 × English mono, 0.70)
  for German and Russian (0.600) and Korean and Thai (0.433). Thai mono (0.733) misses the mono bar
  (0.9 × English). The relevance gate drops the cross-lingual matches; the design's gate-miss rerank
  (multilingual design of 8 November, §3) targets exactly this.
- **Rerank makes abstention worse:** abstention FP rises from 0–0.25 to 0.50–1.00, above the bar
  (English + 0.1) in most languages. The rerank floor needs calibrating per language (design §6,
  step 2) before the escalation ships.
- **Latency:** recall p50 was about 280 ms without rerank and about 525 ms with it, measured from this
  machine, so the rerank adds about 240 ms. That is why the design reranks only on a gate miss.

## Gate-miss rerank, 2026-11-12

The first calibration below chose and scored its floors on the same rows (in-sample), with 3
unrelated prompts translated into 13 languages. Its numbers flatter the floors. The held-out
evaluation after it is the one to quote.

`recall.rerankWhen: 'gate-miss'` (CON-131): a recall without the reranker that drops every candidate
reranks once when its best dense score reaches `gateMissDenseFloor`, and keeps what scores at least
`gateMissRerankFloor`. The prompt hook turns it on with `recall.promptGateMissRerank`. The floors
were calibrated here with `voyage-3.5-lite` (512 dimensions, int8) and `rerank-3-lite`.

**Method.** One recording run with both floors at 0 keeps, for every row the gate drops, the best
dense score and the rerank score of each candidate. Every pair of floors is then replayed from that
record (`src/gate-miss.ts`), so the grid (dense 0.30 to 0.70, rerank 0.30 to 0.95, steps of 0.01)
costs no more calls. `unrelated.jsonl` then held 3 developer prompts, each translated into every
language, that no memory answers ("refactor this to async/await"), recalled in each condition's
store, to count false injections on ordinary prompts. A pair passes when, for the six gating languages, cross recall@10
is at least 0.75 × English mono recall@10 and abstention FP is at most English's (without the
escalation) + 0.1, and no unrelated prompt or abstention question gets an answer it does not get
without the escalation. Of the passing pairs, the best mean cross recall@10 over the gating
languages, then the highest dense floor within 0.02 of it, since every escalation is a rerank
call on the prompt's critical path. The run cost 657 rerank calls and 22 embedding requests (about
US$0.03). Reproduce it with `VOYAGE_API_KEY=… pnpm --filter @oortmem/bench run calibrate:gate-miss`.

**Chosen then, in-sample: dense 0.51, rerank 0.76.** Recall@10 without / with the escalation,
abstention FP (mono), and the share of rows that paid for a rerank (mono / cross):

| Language | mono R@10     | cross R@10    | mixed R@10    | Abstain FP  | Reranked, mono / cross |
| -------- | ------------- | ------------- | ------------- | ----------- | ---------------------- |
| en       | 0.933 / 0.933 | —             | 0.967 / 0.967 | 0.25 / 0.25 | 0.14 / —               |
| es       | 0.933 / 0.933 | 0.733 / 0.900 | 0.933 / 0.933 | 0.25 / 0.25 | 0.11 / 0.32            |
| pt-BR    | 0.967 / 0.967 | 0.900 / 0.967 | 0.967 / 0.967 | 0.25 / 0.25 | 0.11 / 0.16            |
| de       | 0.933 / 0.967 | 0.600 / 0.867 | 0.967 / 0.967 | 0.00 / 0.00 | 0.16 / 0.35            |
| fr       | 0.900 / 0.933 | 0.767 / 0.867 | 0.900 / 0.933 | 0.25 / 0.25 | 0.14 / 0.24            |
| ja       | 0.833 / 0.933 | 0.700 / 0.867 | 0.867 / 0.967 | 0.00 / 0.00 | 0.14 / 0.16            |
| zh-Hans  | 0.933 / 0.967 | 0.800 / 0.933 | 0.933 / 0.967 | 0.00 / 0.00 | 0.11 / 0.16            |
| ko       | 0.833 / 0.933 | 0.433 / 0.767 | 0.867 / 0.933 | 0.00 / 0.00 | 0.14 / 0.35            |
| hi       | 0.900 / 0.967 | 0.833 / 0.933 | 0.933 / 0.967 | 0.25 / 0.25 | 0.11 / 0.19            |
| ar       | 0.933 / 0.967 | 0.767 / 0.967 | 0.933 / 0.967 | 0.00 / 0.00 | 0.11 / 0.22            |
| th       | 0.733 / 0.900 | 0.433 / 0.800 | 0.767 / 0.933 | 0.00 / 0.00 | 0.22 / 0.43            |
| ru       | 0.833 / 0.900 | 0.600 / 0.867 | 0.867 / 0.967 | 0.25 / 0.25 | 0.24 / 0.38            |
| id       | 0.900 / 0.967 | 0.833 / 0.900 | 0.900 / 0.967 | 0.25 / 0.25 | 0.16 / 0.19            |

- **Cross-lingual recall:** the gating languages' mean cross recall@10 goes from 0.750 to 0.900, and
  every language, Korean and Thai included, now clears 0.75 × English mono (0.70). German, the one
  gating language under the bar without the escalation (0.600), reaches 0.867.
- **Abstention is unchanged:** no abstention FP moves in any cell, and the unrelated prompts get
  exactly the answers they get without the escalation (6 of 114, all in mono and mixed stores).
  English mono recall@10 is unchanged (0.933).
- **The trade-off is the dense floor.** The best pair overall is dense 0.34 (mean cross recall@10
  0.917), but it reranks 93% of the unrelated prompts. 0.51 gives up 0.017 of recall and reranks 49%
  of them, 12% of answerable questions and 9% of English mono questions. At 0.55 recall falls to
  0.867 (32% of unrelated prompts); at 0.60, the gate's own dense floor, the escalation fires for 2%
  of rows and the cross bar fails again. The rerank floor is the abstention side: at dense 0.51,
  0.74 is the lowest that adds no false injection (0.72 injects 3 more unrelated prompts, 0.70
  injects 8 more), and 0.74 to 0.88 all pass, trading cross recall for margin. 0.74 and 0.76 tie
  on recall, so the higher one ships.
- **Latency:** each escalation is one rerank call. From this machine (Europe) the 657 calls took
  275 ms at p50 and 487 ms at p95; the prompt hook's `promptRerankBudgetMs` (400) cuts off the slow
  ones, which then inject nothing. One global pair ships, since recall detects no language; what
  each language alone would choose is in the calibration output (`perLanguage`).

### Held-out evaluation, 2026-11-12 (review)

Three changes after review, and the numbers again from the same recorded scores (no new calls):

- **The best dense score counts only what recall could return:** the fused candidates in view, not
  a superseded or out-of-view memory's dense hit. Scores are a little lower, and the same method
  now chooses **dense 0.49, rerank 0.76**.
- **The bars now also fail floors that answer an abstention question** not answered without the
  escalation, as the method above already said (before, only the FP slack checked them).
- **5-fold held-out by question** (`heldOut` in `src/gate-miss.ts`): a question, with its
  translations in every language and condition, sits in exactly one fold, and each fold is judged
  at the floors chosen from the other four.

| Space (3 unrelated prompts × 13 languages) | Cross R@10, without | In-sample | Held-out | Unrelated injected | Abstention answered | Rerank rate, rows / unrelated |
| ------------------------------------------ | ------------------- | --------- | -------- | ------------------ | ------------------- | ----------------------------- |
| Voyage `voyage-3.5-lite@512`               | 0.750               | 0.900     | 0.883    | 6 → 6 of 114       | 23 → 23             | 20% / 56%                     |

- **Voyage holds up:** held-out cross recall@10 is 0.883 (es 0.900, pt-BR 0.967, de 0.867, fr
  0.867, ja 0.833, zh-Hans 0.867), every bar met, English mono unchanged (0.933). The folds chose
  dense 0.48 to 0.52 and rerank 0.76 to 0.77: the choice is stable.
- **Unrelated prompts are now 65 distinct developer tasks,** five per language, each written in
  its language rather than translated (`unrelated.jsonl`). The 3-prompt numbers above stay as they
  were measured; rerunning with the 65 prompts needs their embeddings and up to 380 rerank calls.

## Baseline, tokeniser v1 (2026-11-06)

Before tokeniser v2 (commit `cd84e56`): the store at `70e1917`, Node 26.13, ICU 78.3. Local models from a throwaway
`OORT_HOME`: `bge-small-en-v1.5` (English-only) and `ms-marco-minilm-l6-v2` (English-only).

**mono** (recall@10 / MRR@10 / abstention FP)

| Language | Lexical            | bge-small          | bge-small + MiniLM |
| -------- | ------------------ | ------------------ | ------------------ |
| en       | 0.77 / 0.75 / 0.25 | 0.97 / 0.93 / 0.50 | 0.93 / 0.92 / 0.00 |
| es       | 0.63 / 0.63 / 0.25 | 0.97 / 0.97 / 1.00 | 0.83 / 0.83 / 0.00 |
| pt-BR    | 0.67 / 0.65 / 0.00 | 1.00 / 0.97 / 1.00 | 0.77 / 0.75 / 0.00 |
| de       | 0.57 / 0.57 / 0.00 | 1.00 / 0.97 / 1.00 | 0.77 / 0.77 / 0.00 |
| fr       | 0.63 / 0.63 / 0.25 | 1.00 / 0.98 / 1.00 | 0.87 / 0.85 / 0.00 |
| ja       | 0.00 / 0.00 / 0.00 | 0.93 / 0.82 / 1.00 | 0.73 / 0.62 / 1.00 |
| zh-Hans  | 0.60 / 0.53 / 0.00 | 0.90 / 0.71 / 1.00 | 0.93 / 0.81 / 1.00 |
| ko       | 0.20 / 0.20 / 0.00 | 0.97 / 0.87 / 1.00 | 0.80 / 0.74 / 1.00 |
| hi       | 0.83 / 0.83 / 0.50 | 0.97 / 0.92 / 1.00 | 0.97 / 0.93 / 1.00 |
| ar       | 0.47 / 0.47 / 0.00 | 0.97 / 0.88 / 1.00 | 0.80 / 0.73 / 1.00 |
| th       | 0.47 / 0.45 / 0.00 | 0.97 / 0.84 / 1.00 | 0.93 / 0.84 / 0.25 |
| ru       | 0.47 / 0.45 / 0.25 | 1.00 / 0.88 / 1.00 | 0.87 / 0.70 / 1.00 |
| id       | 0.67 / 0.65 / 0.00 | 0.93 / 0.90 / 1.00 | 0.77 / 0.77 / 0.00 |

**cross** (recall@10 / MRR@10 / abstention FP)

| Language | Lexical            | bge-small          | bge-small + MiniLM |
| -------- | ------------------ | ------------------ | ------------------ |
| es       | 0.10 / 0.10 / 0.00 | 0.73 / 0.72 / 0.50 | 0.17 / 0.17 / 0.00 |
| pt-BR    | 0.07 / 0.07 / 0.00 | 0.67 / 0.63 / 0.50 | 0.07 / 0.07 / 0.00 |
| de       | 0.07 / 0.07 / 0.00 | 0.70 / 0.67 / 0.25 | 0.13 / 0.13 / 0.00 |
| fr       | 0.03 / 0.03 / 0.00 | 0.60 / 0.58 / 0.75 | 0.17 / 0.17 / 0.00 |
| ja       | 0.00 / 0.00 / 0.00 | 0.47 / 0.41 / 1.00 | 0.20 / 0.17 / 0.00 |
| zh-Hans  | 0.57 / 0.50 / 0.00 | 0.70 / 0.62 / 1.00 | 0.27 / 0.27 / 0.00 |
| ko       | 0.00 / 0.00 / 0.00 | 0.47 / 0.45 / 0.50 | 0.27 / 0.23 / 0.00 |
| hi       | 0.03 / 0.03 / 0.00 | 0.47 / 0.45 / 0.25 | 0.47 / 0.47 / 0.00 |
| ar       | 0.03 / 0.03 / 0.00 | 0.60 / 0.57 / 0.25 | 0.10 / 0.10 / 0.00 |
| th       | 0.07 / 0.07 / 0.00 | 0.73 / 0.68 / 0.75 | 0.43 / 0.43 / 0.00 |
| ru       | 0.10 / 0.10 / 0.00 | 0.57 / 0.52 / 0.50 | 0.03 / 0.03 / 0.00 |
| id       | 0.10 / 0.10 / 0.00 | 0.60 / 0.58 / 0.50 | 0.10 / 0.10 / 0.00 |

**mixed** (recall@10 / MRR@10 / abstention FP)

| Language | Lexical            | bge-small          | bge-small + MiniLM |
| -------- | ------------------ | ------------------ | ------------------ |
| en       | 0.80 / 0.80 / 0.25 | 0.93 / 0.93 / 1.00 | 0.93 / 0.92 / 0.25 |
| es       | 0.67 / 0.67 / 0.25 | 1.00 / 0.97 / 1.00 | 0.83 / 0.83 / 0.00 |
| pt-BR    | 0.67 / 0.63 / 0.00 | 1.00 / 0.93 / 1.00 | 0.77 / 0.77 / 0.00 |
| de       | 0.57 / 0.57 / 0.00 | 1.00 / 0.98 / 1.00 | 0.80 / 0.80 / 0.00 |
| fr       | 0.63 / 0.60 / 0.25 | 1.00 / 0.94 / 1.00 | 0.87 / 0.85 / 0.00 |
| ja       | 0.00 / 0.00 / 0.00 | 0.93 / 0.81 / 1.00 | 0.80 / 0.67 / 1.00 |
| zh-Hans  | 0.60 / 0.52 / 0.00 | 0.87 / 0.75 / 1.00 | 0.93 / 0.78 / 1.00 |
| ko       | 0.23 / 0.23 / 0.00 | 0.97 / 0.90 / 1.00 | 0.83 / 0.74 / 1.00 |
| hi       | 0.83 / 0.74 / 0.50 | 0.97 / 0.89 / 1.00 | 1.00 / 0.93 / 1.00 |
| ar       | 0.47 / 0.47 / 0.00 | 0.97 / 0.90 / 1.00 | 0.83 / 0.72 / 1.00 |
| th       | 0.47 / 0.45 / 0.00 | 0.93 / 0.85 / 1.00 | 0.97 / 0.91 / 0.50 |
| ru       | 0.47 / 0.45 / 0.25 | 1.00 / 0.89 / 1.00 | 0.90 / 0.72 / 1.00 |
| id       | 0.67 / 0.67 / 0.00 | 0.97 / 0.92 / 1.00 | 0.77 / 0.77 / 0.00 |

What it shows:

- **Lexical, mono.** Japanese finds nothing (0.00): v1 keeps a kana or kanji run and the Latin
  identifier next to it as one token (`checkout-webはローカル開発だとポート4173で動いていて`), so a question only matches
  by repeating that exact run. Korean (0.20) keeps particles on words. Chinese reaches 0.60 only
  because writers often put spaces around identifiers. Hindi scores well (0.83) but for the wrong
  reason: v1 shreds Devanagari words at their vowel signs into fragments that question and memory
  share, which also lets half the abstention questions through (FP 0.50).
- **Lexical, cross.** Near zero everywhere except Chinese, as expected: only identifiers are shared
  across languages. Cross-lingual recall has to come from the dense path.
- **bge-small.** The English-only model still ranks well on this small store, mostly on the
  identifiers its word pieces share, but its dense floor (`minDenseScore` 0.6) admits almost
  everything: abstention FP is 1.00 in nearly every language. Cross-lingual recall falls to 0.47 to
  0.73.
- **MiniLM.** The English-only reranker cuts cross-lingual recall to 0.03 to 0.47 and drops
  monolingual recall in most languages, while still passing every abstention question in CJK,
  Korean, Hindi, Arabic and Russian. It should not run on non-English text, as the design says.

## After tokeniser v2 (2026-11-06)

The same runs after tokeniser v2 and schema version 4 (see `docs/store-contract.md`), with word
coverage weighing a CJK run as one word.

**mono** (recall@10 / MRR@10 / abstention FP)

| Language | Lexical            | bge-small          | bge-small + MiniLM |
| -------- | ------------------ | ------------------ | ------------------ |
| en       | 0.77 / 0.75 / 0.25 | 0.97 / 0.93 / 0.50 | 0.93 / 0.92 / 0.00 |
| es       | 0.63 / 0.62 / 0.25 | 0.97 / 0.95 / 1.00 | 0.83 / 0.83 / 0.00 |
| pt-BR    | 0.67 / 0.65 / 0.00 | 1.00 / 0.95 / 1.00 | 0.77 / 0.75 / 0.00 |
| de       | 0.57 / 0.57 / 0.00 | 1.00 / 0.97 / 1.00 | 0.77 / 0.77 / 0.00 |
| fr       | 0.63 / 0.63 / 0.25 | 1.00 / 0.98 / 1.00 | 0.87 / 0.85 / 0.00 |
| ja       | 0.67 / 0.65 / 0.00 | 1.00 / 0.90 / 1.00 | 0.73 / 0.59 / 1.00 |
| zh-Hans  | 0.87 / 0.83 / 0.00 | 0.97 / 0.91 / 1.00 | 0.90 / 0.79 / 1.00 |
| ko       | 0.53 / 0.53 / 0.00 | 1.00 / 0.91 / 1.00 | 0.80 / 0.74 / 1.00 |
| hi       | 0.50 / 0.50 / 0.00 | 0.97 / 0.92 / 1.00 | 0.97 / 0.93 / 1.00 |
| ar       | 0.47 / 0.47 / 0.00 | 0.97 / 0.88 / 1.00 | 0.80 / 0.73 / 1.00 |
| th       | 0.63 / 0.63 / 0.00 | 1.00 / 0.88 / 1.00 | 0.93 / 0.84 / 0.50 |
| ru       | 0.47 / 0.45 / 0.25 | 1.00 / 0.88 / 1.00 | 0.87 / 0.70 / 1.00 |
| id       | 0.67 / 0.65 / 0.00 | 0.93 / 0.90 / 1.00 | 0.77 / 0.77 / 0.00 |

**cross** (recall@10 / MRR@10 / abstention FP)

| Language | Lexical            | bge-small          | bge-small + MiniLM |
| -------- | ------------------ | ------------------ | ------------------ |
| es       | 0.10 / 0.10 / 0.00 | 0.73 / 0.72 / 0.50 | 0.17 / 0.17 / 0.00 |
| pt-BR    | 0.07 / 0.07 / 0.00 | 0.67 / 0.63 / 0.50 | 0.07 / 0.07 / 0.00 |
| de       | 0.07 / 0.07 / 0.00 | 0.70 / 0.67 / 0.25 | 0.13 / 0.13 / 0.00 |
| fr       | 0.03 / 0.03 / 0.00 | 0.60 / 0.58 / 0.75 | 0.17 / 0.17 / 0.00 |
| ja       | 0.50 / 0.45 / 0.00 | 0.60 / 0.55 / 1.00 | 0.20 / 0.17 / 0.00 |
| zh-Hans  | 0.60 / 0.53 / 0.00 | 0.70 / 0.62 / 1.00 | 0.27 / 0.27 / 0.00 |
| ko       | 0.03 / 0.03 / 0.00 | 0.47 / 0.42 / 0.50 | 0.27 / 0.23 / 0.00 |
| hi       | 0.03 / 0.03 / 0.00 | 0.47 / 0.45 / 0.25 | 0.47 / 0.47 / 0.00 |
| ar       | 0.07 / 0.07 / 0.00 | 0.60 / 0.57 / 0.25 | 0.10 / 0.10 / 0.00 |
| th       | 0.10 / 0.10 / 0.00 | 0.73 / 0.68 / 0.75 | 0.43 / 0.43 / 0.00 |
| ru       | 0.10 / 0.10 / 0.00 | 0.57 / 0.52 / 0.50 | 0.03 / 0.03 / 0.00 |
| id       | 0.10 / 0.10 / 0.00 | 0.60 / 0.58 / 0.50 | 0.10 / 0.10 / 0.00 |

**mixed** (recall@10 / MRR@10 / abstention FP)

| Language | Lexical            | bge-small          | bge-small + MiniLM |
| -------- | ------------------ | ------------------ | ------------------ |
| en       | 0.80 / 0.80 / 0.25 | 0.93 / 0.93 / 1.00 | 0.93 / 0.92 / 0.25 |
| es       | 0.67 / 0.67 / 0.25 | 1.00 / 0.97 / 1.00 | 0.83 / 0.83 / 0.00 |
| pt-BR    | 0.67 / 0.61 / 0.00 | 1.00 / 0.93 / 1.00 | 0.77 / 0.77 / 0.00 |
| de       | 0.57 / 0.57 / 0.00 | 1.00 / 0.98 / 1.00 | 0.80 / 0.80 / 0.00 |
| fr       | 0.63 / 0.60 / 0.25 | 1.00 / 0.95 / 1.00 | 0.87 / 0.85 / 0.00 |
| ja       | 0.70 / 0.68 / 0.00 | 1.00 / 0.92 / 1.00 | 0.77 / 0.65 / 1.00 |
| zh-Hans  | 0.80 / 0.80 / 0.00 | 0.97 / 0.88 / 1.00 | 0.97 / 0.79 / 1.00 |
| ko       | 0.53 / 0.53 / 0.00 | 1.00 / 0.94 / 1.00 | 0.83 / 0.76 / 1.00 |
| hi       | 0.50 / 0.50 / 0.00 | 0.97 / 0.91 / 1.00 | 1.00 / 0.95 / 1.00 |
| ar       | 0.47 / 0.47 / 0.00 | 0.97 / 0.91 / 1.00 | 0.83 / 0.73 / 1.00 |
| th       | 0.63 / 0.63 / 0.00 | 0.93 / 0.83 / 1.00 | 0.97 / 0.91 / 0.50 |
| ru       | 0.47 / 0.45 / 0.25 | 1.00 / 0.89 / 1.00 | 0.90 / 0.71 / 1.00 |
| id       | 0.67 / 0.67 / 0.00 | 0.97 / 0.92 / 1.00 | 0.77 / 0.77 / 0.00 |

### Before and after, recall@10 (v1 → v2)

| Language | Condition | Lexical     | bge-small   | bge-small + MiniLM |
| -------- | --------- | ----------- | ----------- | ------------------ |
| en       | mono      | 0.77 → 0.77 | 0.97 → 0.97 | 0.93 → 0.93        |
| es       | mono      | 0.63 → 0.63 | 0.97 → 0.97 | 0.83 → 0.83        |
| pt-BR    | mono      | 0.67 → 0.67 | 1.00 → 1.00 | 0.77 → 0.77        |
| de       | mono      | 0.57 → 0.57 | 1.00 → 1.00 | 0.77 → 0.77        |
| fr       | mono      | 0.63 → 0.63 | 1.00 → 1.00 | 0.87 → 0.87        |
| ja       | mono      | 0.00 → 0.67 | 0.93 → 1.00 | 0.73 → 0.73        |
| zh-Hans  | mono      | 0.60 → 0.87 | 0.90 → 0.97 | 0.93 → 0.90        |
| ko       | mono      | 0.20 → 0.53 | 0.97 → 1.00 | 0.80 → 0.80        |
| hi       | mono      | 0.83 → 0.50 | 0.97 → 0.97 | 0.97 → 0.97        |
| ar       | mono      | 0.47 → 0.47 | 0.97 → 0.97 | 0.80 → 0.80        |
| th       | mono      | 0.47 → 0.63 | 0.97 → 1.00 | 0.93 → 0.93        |
| ru       | mono      | 0.47 → 0.47 | 1.00 → 1.00 | 0.87 → 0.87        |
| id       | mono      | 0.67 → 0.67 | 0.93 → 0.93 | 0.77 → 0.77        |
| es       | cross     | 0.10 → 0.10 | 0.73 → 0.73 | 0.17 → 0.17        |
| pt-BR    | cross     | 0.07 → 0.07 | 0.67 → 0.67 | 0.07 → 0.07        |
| de       | cross     | 0.07 → 0.07 | 0.70 → 0.70 | 0.13 → 0.13        |
| fr       | cross     | 0.03 → 0.03 | 0.60 → 0.60 | 0.17 → 0.17        |
| ja       | cross     | 0.00 → 0.50 | 0.47 → 0.60 | 0.20 → 0.20        |
| zh-Hans  | cross     | 0.57 → 0.60 | 0.70 → 0.70 | 0.27 → 0.27        |
| ko       | cross     | 0.00 → 0.03 | 0.47 → 0.47 | 0.27 → 0.27        |
| hi       | cross     | 0.03 → 0.03 | 0.47 → 0.47 | 0.47 → 0.47        |
| ar       | cross     | 0.03 → 0.07 | 0.60 → 0.60 | 0.10 → 0.10        |
| th       | cross     | 0.07 → 0.10 | 0.73 → 0.73 | 0.43 → 0.43        |
| ru       | cross     | 0.10 → 0.10 | 0.57 → 0.57 | 0.03 → 0.03        |
| id       | cross     | 0.10 → 0.10 | 0.60 → 0.60 | 0.10 → 0.10        |
| en       | mixed     | 0.80 → 0.80 | 0.93 → 0.93 | 0.93 → 0.93        |
| es       | mixed     | 0.67 → 0.67 | 1.00 → 1.00 | 0.83 → 0.83        |
| pt-BR    | mixed     | 0.67 → 0.67 | 1.00 → 1.00 | 0.77 → 0.77        |
| de       | mixed     | 0.57 → 0.57 | 1.00 → 1.00 | 0.80 → 0.80        |
| fr       | mixed     | 0.63 → 0.63 | 1.00 → 1.00 | 0.87 → 0.87        |
| ja       | mixed     | 0.00 → 0.70 | 0.93 → 1.00 | 0.80 → 0.77        |
| zh-Hans  | mixed     | 0.60 → 0.80 | 0.87 → 0.97 | 0.93 → 0.97        |
| ko       | mixed     | 0.23 → 0.53 | 0.97 → 1.00 | 0.83 → 0.83        |
| hi       | mixed     | 0.83 → 0.50 | 0.97 → 0.97 | 1.00 → 1.00        |
| ar       | mixed     | 0.47 → 0.47 | 0.97 → 0.97 | 0.83 → 0.83        |
| th       | mixed     | 0.47 → 0.63 | 0.93 → 0.93 | 0.97 → 0.97        |
| ru       | mixed     | 0.47 → 0.47 | 1.00 → 1.00 | 0.90 → 0.90        |
| id       | mixed     | 0.67 → 0.67 | 0.97 → 0.97 | 0.77 → 0.77        |

What changed:

- **English is identical** in every condition and configuration, as the golden tests require.
  So are Spanish, Portuguese, German, French, Arabic, Russian and Indonesian, whose text v2
  tokenises as v1 did (the memories and questions use accents consistently, so folding does not
  show here).
- **Lexical CJK and Thai recover:** Japanese 0.00 → 0.67, Chinese 0.60 → 0.87, Korean 0.20 →
  0.53, Thai 0.47 → 0.63. Identifiers written against kana or Hangul are their own tokens now, so
  Japanese cross-lingual lexical recall goes from 0.00 to 0.50.
- **Hindi lexical falls, 0.83 → 0.50, and that is the honest number.** v1's score came from
  shredded fragments that also let half the abstention questions through; v2 keeps words whole
  and abstention FP drops from 0.50 to 0.00. With the gate off, v2 ranks the right Hindi memory
  first almost every time (MRR 0.98): what drops it is the coverage gate, because Hindi function
  words (का, में, है, को) count as informative. The 0.7 stopword work should include Hindi, not
  only the Latin-script languages.
- **Coverage over bigrams.** Counting every bigram as a word made a question's own wording outweigh
  the identifier it names (Chinese lexical fell to 0.27 in a first run). Word coverage now weighs
  each CJK run as one word, with the share of its bigrams found, which is never less than v1 gave.
- **bge-small** gains a little in CJK and Thai (lexical candidates are better), but its dense floor
  still admits every abstention question. **MiniLM** is unchanged: the reranker's gate decides.
- **Cross-lingual** recall still needs the multilingual embedder and the cross-lingual gate (0.7).

## Review notes

Choices the writers flagged, for the native-speaker review:

- **Numbers.** "2,000 requests per second" (f27) is written the local way where a comma would read
  as a decimal: `2000` (es, ru, id), `2.000` (pt-BR, de), `2 000` (fr). French uses `10 Mo` (f21).
- **"Start of the summer"** (temporal row 30, `asOf` 2026-06-05) is "early June" where summer is
  another season or absent: es, pt-BR, th and id. The others keep "start of summer".
- **Loanwords.** Every language keeps English terms where its developers usually do (deploy,
  staging, flaky, tenant, commit, on-call...). Reviewers may want more of them localised; Hindi and
  Thai keep the most Latin-script terms, Arabic uses colloquial "نعمل hash".
- **"Page her"** (f05) has no settled translation: ja 呼び出す, zh 呼她, ko 호출할 것, ru
  пейджнуть, fr "la pager", id "page dia".
- **Quotes.** The commit-message example (f06) is unchanged inside local quotation marks
  (「」, “”, „“, « »).
- **Register.** Questions are casual chat (tú, du, tu, 해요체, plain or です/ます Japanese).
