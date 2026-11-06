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

**Vendor models (not run yet).** The cloud's models need `VOYAGE_API_KEY` and are run by hand:

```sh
VOYAGE_API_KEY=… pnpm eval --set multilingual --embed voyage --rerank voyage --out voyage.json
# a specific model: --embed voyage:voyage-3.5-lite --rerank voyage:rerank-3-lite
```

That run answers the design's main open question (is `voyage-3.5-lite` good enough per language?)
and calibrates the cross-lingual `minDenseScore` (design §4.3). It embeds about 3,100 memories and 1,300
questions, and makes at most one rerank call per question and condition. Record its table here when it runs.

`src/multilingual.test.ts` runs the lexical condition set and compares it with
`baseline-lexical.json`. A tokeniser change shows up there as a changed number;
`OORT_UPDATE_GOLDEN=1` rewrites it, which is only right for an intended change, with the tables
below updated in the same commit.

## Baseline, tokeniser v1 (2026-11-06)

Before tokeniser v2: the store at `70e1917`, Node 26.13, ICU 78.3. Local models from a throwaway
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
