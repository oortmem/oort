# Multilingual memory: one language setting, automatic routing

Date: 2026-11-06. Status: proposed design. Issues: CON-110 (this spec), CON-96 (local multilingual
embedder). Releases: nothing here goes into **0.6.0** (the SDK launch). Each item is tagged
**[0.6.x]**, **[0.7]** or **[later]**.

Companies whose users write in many languages need memory that works in all of them, in Oort
Cloud above all. The requirement is one setting and automatic routing, not per-feature setup.
§1 audits every stage of the write and read paths for non-English text. §2 gives the decisions,
§3 to §10 the design, §11 the evals, §12 the phases and §13 the open questions. §14 holds the
notes that are specific to operating Oort Cloud; it can move to the private repo.

## 0. Decisions in brief

1. **One setting: `language: 'auto' | 'en' | 'multi'`, default `auto`.** Locally it is a home
   config key (a store has one embedder, so a project cannot choose its own). In Oort Cloud it is
   an account setting, and an organisation can set a default for its members. `oort language`
   and a dashboard toggle change it.
2. **The lexical pipeline is not a setting.** Tokeniser v2 is script-aware for every text. It
   splits CJK into bigrams, segments Thai, Lao, Khmer and Myanmar into words, keeps combining marks
   and normalises to NFKC. Its output for plain English is identical to today's, so the change
   needs no toggle and fixes a real bug: Devanagari and Thai words are shredded today (§1.3).
3. **One embedding space per store; no per-memory embedder routing.** Two spaces cannot be fused
   in one dense search. They would also break cross-lingual recall, where a Spanish question finds
   an English memory, and the cloud's shared-node fan-out, which embeds a query once for every
   node. Oort Cloud keeps `voyage-3.5-lite` for every account, whatever the setting. Locally,
   `auto` keeps the English model for English stores and moves a store to `multilingual-e5-small`
   once its memories show other languages.
4. **What `auto` routes per text:** the tokeniser path (by script), the date parser's locales,
   and the relevance gate, which for cross-lingual matches relies on the reranker or a calibrated
   dense score instead of shared words. The writer reports each fact's language, which drives the
   statistics `auto` acts on.
5. **Facts stay in the user's language.** The writer prompt gets an explicit language rule now
   [0.6.x]. In [0.7] it also returns the fact's language and its validity dates as structured
   fields, so date bounds stop depending on English cue words.
6. **Jev stays the decision model; it is measured, not assumed.** Jev 1.14's changelog says
   "Better multilingual support" but publishes no language list. Where a language measures badly,
   the write path leans to ADD over SUPERSEDE or CORRECT: a duplicate is cheap and a lost fact is
   not.
7. **Switching is cheap where it matters.** Tokeniser v2 rebuilds the FTS index from stored text,
   with no vendor calls: 20,000 rows took 0.29 s locally. A local model switch goes through the
   existing `oort reembed` and embedder binding. Oort Cloud needs no re-embedding, because its
   embedding space does not change.
8. **Evals gate it.** A multilingual set in `packages/bench/eval/multilingual/` covers 6 gating
   languages plus English (Spanish, Brazilian Portuguese, German, French, Japanese, Simplified
   Chinese) and 6 tracked ones (Korean, Hindi, Arabic, Thai, Russian, Indonesian). It measures
   monolingual, cross-lingual and mixed-store recall, all against English.

## 1. Audit: what works for non-English text today

"Works" means a non-English memory is written, found and injected as well as an English one.
Local means the defaults (Voyage with a key, or local ONNX models). Cloud means Oort Cloud, which
runs the same core with `voyage-3.5-lite`, `rerank-3-lite`, `claude-haiku-5-5` and `jev-latest`.
Unless noted, file references are to this repo at `70e1917`.

### 1.1 Summary

| Stage                     | Local (Voyage)  | Local (ONNX)    | Cloud           | Why                                                           |
| ------------------------- | --------------- | --------------- | --------------- | ------------------------------------------------------------- |
| Scrub                     | Mostly          | Mostly          | Mostly          | Key prefixes and entropy are language-neutral; keywords are English |
| Gate (prompt)             | Partly          | Partly          | Partly          | 12-character floor drops short CJK prompts; English acks only |
| Gate (write, Jev)         | Unmeasured      | Unmeasured      | Unmeasured      | English instructions, non-English state; no published coverage |
| Writer (Haiku)            | Yes, unpinned   | Yes, unpinned   | Yes, unpinned   | Strong model; the prompt never says which language to write   |
| Decide (Jev reconcile)    | Unmeasured      | Unmeasured      | Unmeasured      | As the gate                                                   |
| Embed                     | Likely          | **No**          | Likely          | voyage-3.5-lite is evaluated on multilingual data; bge-small is English-only |
| Store, FTS index          | **No** for CJK, Thai, Indic | same | same     | Tokeniser bug (§1.3)                                          |
| Date cues                 | **No**          | **No**          | **No**          | English prefilter, English chrono parser, English cue words   |
| Lexical-first             | Degrades safely | Degrades safely | Degrades safely | English stopwords; CJK never confident, so it embeds          |
| Lexical / FTS             | **No** for CJK, Thai, Indic | same | same     | As the store                                                  |
| Dense                     | Likely          | **No**          | Likely          | As embed                                                      |
| Fusion (RRF)              | Yes             | Yes             | Yes             | Rank-based, language-neutral                                  |
| Rerank                    | Likely          | **No** (MiniLM) | Likely          | rerank-3-lite is evaluated on 31 languages; MiniLM is English-only |
| Relevance gate            | Partly          | Partly          | Partly          | Word coverage fails cross-lingually; dense floor uncalibrated for it |
| Injection                 | Yes             | Yes             | Yes             | Budget counts characters, so CJK uses about 3x the tokens     |

### 1.2 Write path

**Scrub.** Vendor key prefixes (`packages/core/src/scrub.ts:528-588`) and the high-entropy rule
(`scrub.ts:642`) work on any text. The credential keyword rule is English:
`/secret|token|passw(?:or)?d|api_?key|private_?key|access_?key/gi` (`scrub.ts:75`). So
`contraseña: hunter2`, `Passwort=…` and `パスワード：…` are not caught unless the value is long and
random enough for the entropy rule. Code and config keys are usually English even in non-English
conversations, which limits the exposure. Severity: low.

**Prompt gate.** `shouldRecall` skips prompts under 12 UTF-16 code units
(`packages/core/src/gate.ts:25,33`). `認証のポートは？` ("the auth port?") is 8 characters, a full
question, and is skipped. The acknowledgement list is English only (`gate.ts:2-23`), so
`gracias`, `はい` and `好的` trigger a recall. That costs a lookup, and the relevance gate then
drops the result. Severity: medium for CJK, low otherwise.

**Write gate and reconcile (Jev).** The questions are English
(`packages/decide-jev/src/questions.ts:6-77`) and the state is the turn as written. TypeSafe's
model page lists `jev-1.14.0` as `jev-latest`, with 64k per-request context. It says Jev "reads
natural-language text" but names no languages
([models](https://docs.typesafe.ai/models.md)). The Jev 1.14 changelog entry (14 October 2026)
says "Better multilingual support" ([changelog](https://docs.typesafe.ai/changelog.md)). The
known weaknesses page does not mention natural languages
([model jaggedness](https://docs.typesafe.ai/model-jaggedness.md)). So Jev is not English-only,
but its quality per language is unknown. Severity: unknown, so §11 measures it.

**Writer (Claude Haiku 5.5).** The default writer is `claude-haiku-5-5`
(`packages/core/src/config.ts:28`). Anthropic's multilingual page gives Haiku 5.5's zero-shot
Global-MMLU score as a share of its English score: Spanish 98.1%, Brazilian Portuguese 98.1%,
French 97.7%, German 97.4%, Simplified Chinese 97.7%, Japanese 97.4%, Korean 97.0%, Arabic 96.6%,
Hindi 96.6%, Bengali 95.4%, Swahili 94.0% and Yoruba 87.0%. The same page advises stating the
response language explicitly, in the system prompt, and keeping native scripts
([multilingual support](https://platform.claude.com/docs/en/build-with-claude/multilingual-support)).
The writer prompt never names a language (`packages/writer/src/prompt.ts:8-20`). Its date rule is
written with English examples (`prompt.ts:14`). The model is capable, but whether a Japanese fact
stays Japanese or comes back in English is left to inference. Severity: medium, and the fix is a
one-line rule (§7).

**Write-path matching.** Reinforcement without a store (`strongMatch`,
`packages/core/src/observe.ts:120-125,570-580`) counts shared lexical tokens. With today's
tokeniser a CJK sentence is one token, so a re-observed CJK fact is never reinforced; it is
skipped instead. Candidate search (`observe.ts:145-166`) uses both dense and lexical, so dense
covers for the lexical miss when the embedder handles the language.

**Embed.** The default is `voyage-3.5-lite` at 512 dimensions, int8
(`config.ts:6-13`; the request at `packages/embed-voyage/src/index.ts:58-76`). Voyage's model table
describes `voyage-3.5` as "optimized for general-purpose and multilingual retrieval quality". It
describes `voyage-3.5-lite` only as "optimized for latency and cost"
([embeddings](https://docs.voyageai.com/docs/embeddings)). Voyage's launch post scores both models
across eight domains, one of which is multilingual ("62 datasets covering 26 languages"). It
publishes no per-language figures for the lite model
([voyage-3.5](https://blog.voyageai.com/2025/05/20/voyage-3-5/)). The same docs page says "all
embeddings created with the 4 series are compatible with each other", which matters for §8.
Verdict: multilingual-capable, not documented as multilingual-optimised. Measure it before
promising anything (§11).

Locally, the default ONNX embedder is `bge-small-en-v1.5`, "BGE small, English"
(`packages/local-models/src/catalog.ts:80-111`). It is English-only. The only multilingual local
embedder is `qwen3-embedding-0.6b`, at 614 MB, which is too slow to load for hooks
(`catalog.ts:148-186`).

**Store.** Both stores index text that core's `tokenizeLexical` has already tokenised, joined by
spaces (`packages/store-sqlite/src/index.ts:156-165`). FTS5 is created with
`unicode61 remove_diacritics 0 tokenchars '-_.'` (`packages/store-sqlite/src/schema.ts:19,443-447`).
Oort Cloud uses the same tokeniser string. See §1.3 for why this fails.

### 1.3 The tokeniser bug (measured)

`tokenizeLexical` lowercases, then splits on anything that is not `\p{L}`, `\p{N}`, `-`, `_` or
`.` (`packages/core/src/tokenize.ts:7-13`). Two things go wrong:

- **Combining marks (`\p{M}`) are treated as separators.** Devanagari vowel signs and Thai vowel
  marks are combining marks, so words are cut apart and the marks dropped.
- **Unsegmented scripts become one token per run.** Chinese and Japanese do not separate words
  with spaces, so a whole clause is one token, and a query matches only when it repeats that clause
  exactly.

The tokeniser's output on 2026-11-06 (Node 26.13, ICU 78.3):

| Text                                     | Today's tokens                                         |
| ---------------------------------------- | ------------------------------------------------------ |
| `El servicio de autenticación usa…`      | `el servicio de autenticación usa …` (fine)            |
| `认证服务使用端口8080`                   | `认证服务使用端口8080` (one token)                     |
| `認証サービスはポート8080を使います`     | one token                                              |
| `인증 서비스는 포트 8080을 사용합니다`   | `인증 서비스는 포트 8080을 사용합니다` (particles stuck on) |
| `บริการยืนยันตัวตนใช้พอร์ต 8080`         | `บร การย นย นต วตนใช พอร ต 8080` (shredded)            |
| `प्रमाणीकरण सेवा पोर्ट 8080…`            | `प रम ण करण स व प र ट 8080 …` (shredded)               |

FTS5 compounds this. `unicode61` treats only categories `L* N* Co` as token characters by
default, so it also splits at combining marks ([FTS5, §4.3.1](https://sqlite.org/fts5.html)). A
check with the repo's `better-sqlite3` (SQLite 3.53.4) confirmed both failures. It also showed
that `categories 'L* N* Co M*'` keeps `हिंदी` and `บริการยืนยันตัวตน` whole, and that no `icu`
tokenizer is compiled in. The same `categories` option and the `trigram` tokenizer both work in
SQLite-backed storage under workerd `1.20261102.1`. Effect: lexical recall, the lexical-first
skip, word coverage in the relevance gate and write-path reinforcement all fail for Chinese,
Japanese, Thai and Indic scripts. Korean partly works.

### 1.4 Read path

**Date cues.** `mayHaveDateCue` is an English regex prefilter (weekday, month and casual words;
`packages/core/src/date-cue.ts:12-65`). Text without an English or numeric cue never loads chrono.
When chrono does run, `temporal.ts` calls `chrono.parse`, the English casual parser
(`packages/core/src/temporal.ts:25`). Validity bounds need English cue words before the date (`UNTIL`,
`FROM`, `temporal.ts:51-57`). Query intent needs English phrases (`KNOWN`, `HISTORY_QUESTIONS`,
`temporal.ts:190-206`). The failure is graceful. A non-English query falls back to the `current`
view, which is today's behaviour for a query without a date. A non-English memory gets no
`validTo`, so "valid until Friday", written in Spanish, never expires by itself. Numeric dates
(`2026-11-06`, `17:30`) are found in any language, but without an English cue they count as
keywords, not bounds. chrono-node 2.10.3 (MIT) exports parsers for `en de fr ja pt nl zh ru es uk
it sv fi vi id ar`; there is no Korean, Hindi or Thai. A check showed `es`, `de`, `fr`, `pt`,
`ja` and `zh` reading "Friday" and "yesterday" in their own languages.

**Lexical-first** (`packages/core/src/recall.ts:206-215`; `lexicalIsConfident` at `recall.ts:637-655`). The test
skips the embedding only when the top lexical hit holds every informative query word. Stopwords
are English (`packages/core/src/relevance.ts:9-18`), so for other languages the function words
count as informative, and the test rarely passes. That costs an embedding call, never a wrong
answer. CJK never passes at all, for the same reason.

**Lexical (FTS).** It fails as in §1.3.

**Dense.** It follows the embedder: likely fine with Voyage, broken with `bge-small-en-v1.5`.

**Fusion** (`packages/core/src/fusion.ts:47-58,115-131`). RRF uses ranks only, so it is
language-neutral.

**Rerank.** The default is `rerank-3-lite` (`config.ts:15-21`). The CLI's relay allow-list also
admits `rerank-2.5-lite` (`packages/cli/src/relay.ts:23-24`). Voyage's docs say the 2.5 models
have "multilingual support". They say nothing about languages for the 3 models
([reranker](https://docs.voyageai.com/docs/reranker)). The rerank-3 launch post adds that "the
multilingual domain is composed of 51 datasets from 31 languages", and that "`rerank-3-lite`
outperforms `rerank-2.5-lite` by 0.80%" on it
([rerank-3](https://blog.voyageai.com/2026/09/30/rerank-3/)). So it is likely fine. Locally,
`ms-marco-minilm-l6-v2` is English-only (`catalog.ts:113-146`). `bge-reranker-v2-m3` is
multilingual, but it is 571 MB, large and uncalibrated (`catalog.ts:188-220`).

**Relevance gate** (`recall.ts:324-337`). With a reranker score the gate uses it. Without one,
which is the prompt hook's default `promptMode: 'fast'` (`config.ts:90`), a memory needs half the
query's informative words (`minCoverage` 0.5) or a dense score of at least 0.6 (`minDenseScore`,
"Provisional", `config.ts:59-61`). A Spanish question about an English memory shares almost no
words, so only the dense floor can admit it. Cross-lingual cosine scores usually run lower than
monolingual ones, and 0.6 was never calibrated on them. Expect cross-lingual matches to be dropped
in `fast` mode.

**Injection.** The block's labels ("today", "3d ago", `recall.ts:689-698`) are English. They are
read by the agent's model, so that is fine. The budget is in characters (`budgetChars` 6000,
`config.ts:49`). A CJK character is roughly one token where English averages several characters
a token, so a CJK block costs about three times the context for the same budget.

## 2. Goals and non-goals

Goals:

- Memories written, found and injected in any language, at quality close to English, both in Oort
  Cloud and locally.
- Cross-lingual recall: a question in one language finds a memory written in another.
- One setting, with automatic behaviour by default. English-only users lose nothing, in speed or
  in quality.

Non-goals:

- Translating memories. Facts stay as written (§7).
- Localising the CLI, the dashboard or the injection block's labels.
- Right-to-left layout in the star map (a separate UI issue).

## 3. The setting

```jsonc
// ~/.oort/config.json
{ "language": "auto" } // 'auto' (default) | 'en' | 'multi'
```

| Value   | Lexical (§5)    | Date cues (§6)                      | Local models (§4)              | Cloud models          | Relevance gate (§4.3) |
| ------- | --------------- | ----------------------------------- | ------------------------------ | --------------------- | --------------------- |
| `en`    | Tokeniser v2    | English only                        | bge-small-en + MiniLM          | voyage-3.5-lite, rerank-3-lite | English thresholds |
| `auto`  | Tokeniser v2    | English plus the store's languages  | English until the store is not; then suggests `multi` | same | Per-query: cross-lingual aware |
| `multi` | Tokeniser v2    | Every chrono locale                 | multilingual-e5-small (+ optional multilingual reranker) | same | Cross-lingual aware |

- **Local: home config only [0.7].** Add `language` to `HOME_ONLY_KEYS`
  (`packages/core/src/config.ts:173`). One machine has one `oort.sqlite` and one embedder binding,
  so a repository's `oort.config.json` cannot choose a model for every project on the machine. The
  config schema is strict (`config.ts:146`), so an older CLI rejects a config that holds
  `language`. Write the key only when the user picks a value other than `auto`, and say so in the
  release notes.
- **Cloud: per account, with an organisation default [0.7].** An account's explicit value wins,
  then its organisation's default, then `auto`. In Oort Cloud the three values share one embedding
  space (§4.1), so switching never re-embeds. That makes the toggle safe to expose to every
  account.
- **CLI [0.7].** `oort language` prints the setting, the detected mix ("212 memories: en 81%,
  ja 12%, es 7%"), the active models and what a switch would cost. `oort language multi`,
  `oort language en` and `oort language auto` set it. For a local store that needs a new model,
  the command lists the steps, a pull of about 135 MB and a re-embed of N memories, and runs them
  after one confirmation, or right away with `--yes`. In cloud mode it calls the account API.
  Output follows the `oort.v1` JSON contract.
- **Dashboard [0.7].** Under Settings, then Memory, a Language control: *Auto (recommended)*,
  *English only*, *Multilingual*. It shows the detected mix and a line on what each choice does.
- **Setup [0.7].** `oort setup` reads the system locale (`Intl.DateTimeFormat().resolvedOptions()
  .locale`, else `LANG`). For a non-English locale on local models it offers the multilingual
  embedder up front (CON-96).
- **SDK [0.7].** `createOort({ language })` passes the value through. 0.6.0 does not change.

## 4. Routing in `auto`

### 4.1 One embedding space per store (decision)

Per-memory or per-query embedder routing is rejected:

- A dense search compares a query vector with stored vectors in one space. Two spaces mean two
  query embeddings, two KNN searches and incomparable scores.
- Cross-lingual recall needs the query and the memory in the same space. With routing, an
  English question would never reach a Japanese memory embedded elsewhere.
- Oort Cloud's shared-node recall embeds the query once and asks every node with that vector.
  Every node must therefore share one space. Today they all use `voyage-3.5-lite` at 512 int8.

So the choice of model belongs to a store, not to a text:

- **Oort Cloud:** one space for every account, `voyage-3.5-lite`, whatever the setting.
  `rerank-3-lite` stays the reranker. Any future model change is a fleet migration (§9.3), never a
  per-account toggle.
- **Local:** `auto` keeps `bge-small-en-v1.5` while the store is English. Once the store holds
  enough non-English memories (§4.2), `auto` recommends `multi`. That moves the whole store to
  `multilingual-e5-small` through `oort reembed`.

**Is one multilingual space for everything better?** In the cloud, yes. Voyage's lite model is
already evaluated on multilingual data, so English loses nothing. Locally the trade-off is real:

| Model                    | English MTEB avg (56 tasks) | Multilingual (MIRACL nDCG@10, 16 languages) | Download (int8 + tokenizer) |
| ------------------------ | --------------------------- | ------------------------------------------- | --------------------------- |
| bge-small-en-v1.5        | 62.17                       | English-only                                | 34 MB                       |
| multilingual-e5-small    | 57.9                        | 60.8 (BM25: 39.3)                           | 118 MB + 17 MB              |

Sources: the [BGE model card](https://huggingface.co/BAAI/bge-small-en-v1.5) (MTEB table) and the
[mE5 technical report](https://arxiv.org/abs/2402.05672), Tables 3 and 4. English loses about 4
points, roughly 7%, and the download is four times larger. An English-only user should not pay
that, so local `auto` does not switch an English store. A store with any real share of other
languages should switch, because bge-small cannot represent them at all.

### 4.2 Detection

Two cheap signals are needed, and neither needs a model at query time:

- **Script, per text, at query and write time.** A zero-dependency classifier uses Unicode
  `Script_Extensions` regexes. It sorts text into Latin, CJK (Han, Kana, Hangul, with
  `scx` so that `ー` counts), Southeast Asian (Thai, Lao, Khmer, Myanmar), Indic, Arabic and
  Hebrew, Cyrillic, Greek and other. It is deterministic, works on a single character, and drives
  the tokeniser (§5) and the date-locale group (§6).
- **Language, per memory, at write time [0.7].** The writer returns `lang` (BCP 47, such as `ja`
  or `pt-BR`) with each fact, at no extra cost: it is the same call, and the model detects
  language well. It is stored on the memory's source record. It feeds the store's language mix
  for `auto`, `oort language`, the dashboard, date locales and the eval. With no writer, as on an
  MCP `remember` call, script detection gives `und` or a script-implied language.

Why not a language-ID library on every text? Candidates, with npm metadata from 2026-11-06:

| Library                  | Licence        | Unpacked size | Languages                     | Notes                                                                 |
| ------------------------ | -------------- | ------------- | ----------------------------- | --------------------------------------------------------------------- |
| Script regex (built in)  | n/a            | 0             | Scripts, not languages        | Deterministic; enough for routing                                     |
| `franc-min` 6.2.0        | MIT            | 127 kB        | 82                            | README: "easily confused on small inputs… pass it big documents"; default `minLength` 10 |
| `franc` 6.2.0            | MIT            | 272 kB        | 187                           | Same caveat                                                           |
| `eld` 2.1.1              | Apache-2.0     | 9.1 MB        | 60                            | Several database sizes; actively published                            |
| `cld3-asm` 4.0.0         | MIT wrapper of Google's CLD3 (Apache-2.0) | 6.6 MB | CLD3 upstream: about 100   | WASM; last published 2023-12-31                                       |
| `tinyld` 1.3.4           | MIT            | 12.2 MB       | not checked                   | Large                                                                 |

Queries are short, so a language-ID library would be least reliable exactly where it would run
most. Routing needs scripts, and the writer already knows the language. Recommendation: no
dependency. If a query-time Latin-language guess is needed later (to choose between Spanish and
English date parsing), use `franc-min` with an allow-list of the store's own languages, and only
on queries of 20 or more characters.

**`auto`'s rule for local stores [0.7].** It suggests `multi` when non-English memories reach 5%
of the last 500 written, or at least 10 in all. It suggests it once in `oort doctor`,
`oort stats` and the SessionStart status line, and asks once in the next interactive command. It
never downloads silently, because a 135 MB download and a re-embed are actions the user should
see. Marcus approved the download in principle; consent per machine is still the right default.
A user who wants no question sets `multi` and gets the pull at once.

### 4.3 Per-query routing that `auto` does

| Signal                                | Path                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| Any query                             | Tokeniser v2 (§5): no setting, no detection cost beyond the script regex      |
| Script group of the query             | chrono locales for that group, limited to the store's languages (§6)          |
| Query script or language ≠ the top candidates' `lang` | Cross-lingual gate: word coverage is not a reason to drop; use the rerank score, or the dense floor calibrated on cross-lingual pairs |
| Cross-lingual, prompt hook in `fast` mode, cloud | Call `rerank-3-lite` anyway, within `promptRerankBudgetMs` (400 ms) |
| Cross-lingual, local, no multilingual reranker | Dense floor only (`minDenseScore`, calibrated per embedder)            |

The cross-lingual gate is the part `auto` most needs. Without it, `fast` mode quietly drops the
cross-lingual matches the multilingual embedder found (§1.4). `minDenseScore` becomes a
per-embedder value from the calibration (§11), as `minRerankScore` already is for the local
reranker.

### 4.4 Mixed-language stores

A store may hold any mix. With one multilingual space and tokeniser v2, mixed stores need nothing
special. Two effects are worth measuring (§11, the mixed condition):

- **Lexical bias.** BM25 favours memories that share surface tokens with the query, so same-
  language memories outrank cross-lingual ones in the lexical list. RRF with the dense list
  corrects most of this. The rerank or cross-lingual gate corrects the rest.
- **Language-cluster bias in dense space.** Some multilingual models score same-language pairs
  higher than equally relevant cross-language pairs. The mixed-store eval compares recall with
  and without other languages present.

## 5. Lexical search for CJK, Thai and other scripts

### 5.1 Tokeniser v2 [0.6.x]

The fix belongs in core's tokeniser. Both stores, the in-memory store, the relevance gate, the
lexical-first test and write-path reinforcement all share it (`tokenize.ts:1-6` says so on
purpose). For each text:

1. Normalise to NFKC, then lowercase. Full-width `ＡＰＩ ｖ２` becomes `api v2`, and decomposed
   accents compose.
2. Split on anything that is not `\p{L}`, `\p{M}`, `\p{N}`, `-`, `_` or `.`. Then trim joiners at
   token ends, as today. Combining marks now stay inside words.
3. Split each token into script runs. Non-CJK, non-Southeast-Asian runs are kept as they are.
4. **CJK runs** (Han, Hiragana, Katakana, Hangul, by `Script_Extensions`) become overlapping
   bigrams, and a one-character run stays a unigram. This is the classic CJK analyser approach.
   It is deterministic and needs no dictionary.
5. **Thai, Lao, Khmer and Myanmar runs** are split by `Intl.Segmenter('und', { granularity:
   'word' })`, keeping `isWordLike` segments. Character bigrams are the fallback if the API is
   missing.
6. **Latin runs** have diacritics folded (NFD, strip marks, recompose), so `autenticacion`
   matches `autenticación`. Marks are kept in every other script, where they are vowels, not
   accents.

A prototype's output (Node 26.13; `Intl.Segmenter` gives the same segments in workerd
`1.20261102.1`):

| Text                                     | Tokeniser v2                                                         |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `The auth-service listens on port 8080.` | `the auth-service listens on port 8080` (unchanged)                  |
| `认证服务使用端口8080`                   | `认证 证服 服务 务使 使用 用端 端口 8080`                            |
| `认证服务用什么端口` (query)             | `认证 证服 服务 务用 用什 什么 么端 端口`: 4 of 8 shared with the memory |
| `認証サービスはポート8080を使います`     | `認証 証サ サー ービ ビス スは はポ ポー ート 8080 を使 使い いま ます` |
| `인증 서비스는 포트 8080을…`             | `인증 서비 비스 스는 포트 8080 을 …`: `서비스` now matches `서비스는` |
| `บริการยืนยันตัวตนใช้พอร์ต 8080`         | `บริการ ยืนยัน ตัว ตน ใช้ พอร์ต 8080`                                |
| `प्रमाणीकरण सेवा पोर्ट 8080…`            | `प्रमाणीकरण सेवा पोर्ट 8080 का उपयोग करती है`                         |

**Why not `Intl.Segmenter` for CJK too?** Its dictionary split `端口` ("port") into `端 口`. Bigrams
have no out-of-vocabulary problem, and they do not change when the ICU data changes between
runtimes. Segmenter is used only where no bigram tradition exists, and where dictionary words beat
character n-grams.

**Why not the FTS5 `trigram` tokenizer?** "Substrings consisting of fewer than 3 unicode
characters do not match any rows" ([FTS5, §4.3.4](https://sqlite.org/fts5.html)). Most Chinese
words are two characters, and a check confirmed that `"服务"` matched nothing under `trigram`.
Trigram would also break today's token semantics (`auth-service-8080` as one token), and it
indexes about three times as many terms.

**Why not ICU?** It is not compiled into `better-sqlite3`, as checked above, and Oort Cloud's
SQLite cannot load extensions.

**FTS5 declaration.** Create the index as `memories_fts2` (locally; the cloud's name is in §14)
with `unicode61 remove_diacritics 0 categories 'L* N* Co M*' tokenchars '-_.'`, so FTS5 does not
re-split at the marks v2 keeps. Folding stays in the JS tokeniser, so FTS5 sees folded text. The
new name makes an older Oort that still has the store open (an MCP server or daemon started before
the upgrade) fail on its next write, instead of writing v1 tokens that no v2 query finds.

**Invariant, tested.** For text with no combining marks, no CJK, Southeast Asian or
diacritic-bearing Latin, and only NFKC-stable characters, v2's output equals v1's. That covers
almost all English text. `recall-golden.json` must not change.

**Relevance with bigrams.** Word coverage over bigrams is a fair proxy, and §11 checks it. The
`minCoverage` of 0.5 may need a CJK value. Stopword lists for the top Latin-script languages
(Spanish, Portuguese, French, German, Italian, Dutch) are added from `stopwords-iso` (MIT), and
function words only [0.7].

### 5.2 Migration of existing indexes

The FTS table is contentless, and it is filled by the store, which already knows how to write a
memory's FTS row (`packages/store-sqlite/src/index.ts:621-633`). A rebuild therefore needs only
stored text, with no vendor calls:

- **Local [0.6.x].** Schema version 4. On open, in one transaction: drop `memories_fts`, create
  `memories_fts2` with the v2 declaration, re-insert every row from `memories` and run FTS5's
  `optimize`. Cold rows index only their stub and entities, as today. Record `lexical_version = 2`
  in `meta`. A prototype rebuilt 20,000 rows in 0.29 s, single-threaded on an M1 Max. BM25's
  totals restart from the live rows (the old index also counted every rewritten row), so lexical
  rankings change once. The downgrade (the existing `to` path, `schema.ts`) rebuilds with v1, as
  `memories_fts` again. Older Oort versions refuse a v4 store, as they refuse any newer one. A hook
  (`migrate: false`) never builds or repairs the index; it refuses and leaves it to `oort doctor`
  or the next command.
- **Oort Cloud [0.6.x].** The same rebuild runs in batches. Queries meanwhile use both
  tokenisations (§14). The cloud must not bump to the core release that contains tokeniser v2
  until its own rebuild ships with that bump: core's v2 query tokens against a v1 index would miss
  CJK, Thai, Indic and accented text, and the cloud would index v2 tokens into a table declared
  for v1.
- **Drift guard.** Store the tokeniser version and ICU's major version. Rebuild on open when the
  tokeniser version differs, or when ICU's major is newer and the store holds Thai, Lao, Khmer or
  Myanmar text (the only scripts whose tokens come from ICU). An index recorded by a newer ICU is
  left alone, so two Node versions do not rebuild in turn, and an unknown ICU never rebuilds.

## 6. Date cues

### 6.1 Today: graceful fallback (no change needed for safety)

Non-English text gets no temporal reading. A query uses the `current` view, and a memory gets no
stated validity bounds. Nothing is misread, but "until Friday", written in Spanish, does not
expire by itself. Document this in `docs/cli.md` [0.6.x].

### 6.2 Write path: structured dates from the writer [0.7]

The writer already converts relative dates to absolute `YYYY-MM-DD` (`prompt.ts:14`), so the hard
part, understanding "el viernes", is already done by a model that handles the language well.
Extend its JSON with optional `validFrom` and `validTo` (ISO), stated only when the turn bounds
the fact. Core uses them directly. `factInterval` (`temporal.ts:83`) stays as the English
cross-check and as the fallback when the writer omits them. `checkWriterDate`
(`temporal.ts:154`) still guards arithmetic slips where chrono can read the turn: English, plus
the chrono locales in §6.3. Elsewhere the writer's date is trusted, and §11 measures it per
language. This removes the English cue-word dependency from the write path for every language
the writer handles, not only chrono's 16.

### 6.3 Read path: chrono locales where they exist [0.7]

- Pick the parsers by script group: Latin tries `en`, then the store's Latin-script languages
  among `es de fr pt nl it sv fi id vi`. Han and Kana use `ja` and `zh`. Cyrillic uses `ru` and
  `uk`. Arabic uses `ar`. chrono's package loads all locales anyway, so this adds no load cost
  beyond the 95 ms chrono itself costs (`date-cue.ts:4-6`).
- Extend `mayHaveDateCue` with weekday, month and relative-day words for the enabled locales. Add
  a script-neutral CJK date pattern (`[0-9０-９]+[年月日]`, `昨日|今日|明日|昨天|今天|明天|先週|上周`).
  The prefilter stays cheap, and a false alarm only costs loading chrono.
- Intent words ("as of", "back then", "how has X changed") get small per-locale tables for the
  six gating languages. Anything unrecognised stays `current`, which is today's safe fallback.
  Korean, Hindi and Thai have no chrono parser. They keep the fallback, while CLI flags
  (`--as-of`) and the SDK's explicit modes work in every language.

## 7. The writer, and query versus memory language

**Facts stay in the user's language [0.6.x].** Add a rule to `WRITER_SYSTEM_PROMPT`:

> 9. Write the text, stub and entities in the language the user wrote in. If the user mixed
> languages, use the one most of the user's own words are in. Never translate. Keep code
> identifiers, ports, paths, versions and names exactly as written (rule 5) in any language.

For UPDATE and SUPERSEDE the new claim follows the current turn's language, even if the prior
memory is in another. The fact's author decides, and the dense space keeps both findable. Make the
date examples in rule 3 language-neutral ("convert relative dates in any language").

**Why not translate to English at write time?** Translation would let English-only local models
and English cue words work. But it loses nuance and names, shows users facts they never wrote,
doubles writer output, and goes against Anthropic's advice to keep native scripts. The
multilingual embedding space already gives cross-lingual recall, so translation is rejected.

**Query language versus memory language.** A Spanish question about an English memory works as
follows:

- **Lexical** finds only language-neutral anchors: identifiers, ports, product names and numbers.
  Those are often the most specific words in a developer's question, and rule 5 keeps them
  verbatim.
- **Dense** carries the meaning across languages, in Voyage's space or e5's.
- **Rerank** with `rerank-3-lite` scores cross-lingual pairs. MiniLM cannot, so locally the
  cross-lingual gate falls back to the calibrated dense floor (§4.3).
- **Injection** keeps the memory in its own language. The agent's model reads mixed-language
  context without trouble.

**Writer `lang` [0.7].** This is the per-memory language field from §4.2. It is optional in the
JSON schema, and invalid values are dropped.

## 8. The decision model (Jev)

**What we know.** Jev reads natural-language text. Version 1.14 claims "better multilingual
support". No languages are listed (§1.2).

**What we do.**

1. Measure [0.7]: run the gate and reconcile on each eval language's turns and on their English
   originals. Report agreement: the same `shouldStore` side of 0.5, salience within one level,
   and the same reconcile action. The bar is 90% agreement in every gating language.
2. Keep the instructions in English. TypeSafe documents English instructions over arbitrary
   state, and Jev's jaggedness page warns about contradictory wording, which translated
   instructions would invite.
3. **If a language misses the bar:** for memories in that language, bias the write path toward
   ADD. Raise the probability SUPERSEDE or CORRECT need, and lower the gate threshold a little.
   That trades duplicates, which consolidation and REINFORCE absorb later, for never wrongly ending
   a true fact. A Claude-based decision controller is the escalation. It would be a new adapter,
   with more latency per write. It is worth building only if a top-market language misses by a
   wide margin, such as under 80% agreement.

## 9. Switching and migration

| Change                                | Local                                                         | Oort Cloud                                         |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Tokeniser v2                          | Automatic FTS rebuild on open (§5.2); sub-second              | Batched rebuild per account store (§14)            |
| `en` → `multi` (or `auto` deciding)   | `oort models pull multilingual-e5-small`, then `oort reembed` | Setting only; nothing to re-embed                  |
| `multi` → `en`                        | `oort reembed` back to bge-small                              | Setting only                                       |
| Future cloud model change (§9.3)      | n/a                                                           | Fleet re-embed, per store, with a binding          |

### 9.1 Local switch

The existing machinery covers it:

- The store records its embedder in `meta` (`packages/store-sqlite/src/embedder.ts:8-22`).
- When config and binding differ, dense recall and saving switch off, with a message pointing to
  `oort reembed` (`EmbedderMismatchError`, `packages/cli/src/local-models.ts:25-37`).
- `oort reembed` recomputes every live and cold vector from stored text, and rebinds only when
  done, so an interrupted run changes nothing (`packages/cli/src/commands/reembed.ts:16-21`).

`multilingual-e5-small` is 384-dimensional and not Matryoshka, so it is zero-padded to the store's
512, as bge-small is. It needs the `query: ` and `passage: ` prefixes "even for non-English
texts", per its model card, and mean pooling. Compute per text is close to bge-small's: both are
12-layer, 384-wide encoders, and the larger vocabulary only changes the embedding lookup. So a
re-embed of 10,000 memories should take minutes on one core. Two risks need measuring under
CON-96 before e5 becomes the multilingual default:

- **The tokenizer file.** `tokenizer.json` is 17 MB, against bge-small's 0.7 MB. Its load time
  per hook process may dominate. The long-lived `oort serve` daemon avoids the cost.
- **Load time.** The 118 MB `model_int8.onnx` file against bge-small's 34 MB.

### 9.2 Cloud

No re-embedding is needed: the setting does not change the embedding space. If a fleet model
change ever happens (§9.3), size it as follows:

- **Tokens.** A memory's text is capped at 600 characters (`prompt.ts:31`). That is at most about
  150 tokens for English and up to about 400 to 600 for CJK. A store of 1 million memories is
  therefore roughly 150 to 400 million embedding tokens.
- **Time.** The Voyage rate limit bounds it, or the Batch API's window for a bulk run. Voyage's
  Batch API supports `voyage-3.5-lite` and the 4 series
  ([batch inference](https://docs.voyageai.com/docs/batch-inference)).

### 9.3 A future cloud model, if the eval asks for one [later]

If `voyage-3.5-lite` misses the bar for CJK or Indic languages, do not fork spaces per account.
Migrate the fleet once to the Voyage 4 series. Its models are documented as producing compatible
embeddings, so accounts on `multi` could later embed documents with `voyage-4`, which Voyage calls
optimised for multilingual retrieval. Everyone else could use `voyage-4-lite`. Queries embedded
by either model would still search every node. That is the only route to per-account model
choice that keeps shared-node recall.

## 10. Smaller pieces

- **Prompt gate [0.6.x].** Count wide characters (East Asian Wide and Fullwidth) as two toward
  the 12-character floor. Add common acknowledgements in the gating languages: `gracias`,
  `obrigado`, `merci`, `danke`, `はい`, `ありがとう`, `好的`, `谢谢`, `네`, `감사합니다`, `ok`
  variants.
- **Scrub [0.7].** Add credential keywords for the gating and tracked languages: `contraseña`,
  `senha`, `mot de passe`, `passwort` and `kennwort`, `パスワード`, `密码` and `密碼`, `비밀번호`,
  `пароль`, `कूटशब्द`. Accept `：` as a delimiter. Every keyword gets a false-positive test.
- **Injection budget [0.7].** Count wide characters as about 3 toward `budgetChars`, so a CJK
  block costs about the same context as an English one.
- **Cloud personal-data gate.** Email, IBAN, card, phone and IP patterns match on format, so they
  are language-neutral. Internationalised email local parts (non-ASCII) are not matched. Track
  this separately.

## 11. Evals

**Where.** `packages/bench/eval/multilingual/`: one corpus file and one question file per
language. That keeps each file under the repo's 500 kB limit. `eval/format.md` gains two optional
row fields, `lang` and `condition` (`mono`, `cross` or `mixed`). `loadEvalRows` already ignores
unknown keys (`packages/bench/src/eval.ts:44-49`), so older readers still work.

**Languages.**

- **Gating (6 plus English):** Spanish, Brazilian Portuguese, German, French, Japanese, Simplified
  Chinese.
- **Tracked (6):** Korean (Hangul), Hindi (Devanagari, combining marks), Arabic (right-to-left),
  Thai (unsegmented), Russian (Cyrillic) and Indonesian. They report from the start and join the
  gating set once they are stable.

**Corpus.** 120 base facts in the style of the synthetic generator: services, ports, package
managers, owners, deadlines, decisions and preferences. Each is written as a memory and then
translated into every language by Claude Opus, with identifiers untranslated (rule 5). A native
speaker reviews 10% of each language, and all of Japanese and Chinese. Each language has about 60
questions:

| Category         | Count | Notes                                                          |
| ---------------- | ----- | -------------------------------------------------------------- |
| single-fact      | 30    | Paraphrased, never a copy of the memory's wording               |
| knowledge-update | 10    | With `notExpectedMemoryIds` for the superseded versions         |
| temporal         | 8     | Localised relative dates ("ayer", "先週", "letzte Woche")       |
| abstention       | 6     | No answer in the store                                          |
| cross-lingual    | 6     | Question in this language, answer memory in English             |

The language-specific corpora are also loaded into one store with the 1,500-memory English
synthetic store as distractors. This is the `mixed` condition.

**Metrics.**

- **Read path.** Recall@5, recall@10, MRR@10, `abstainFp` and `staleLeak` (`computeMetrics`,
  `eval.ts:169`). Each is reported per language and per condition, and as a ratio to English.
  Lexical-only and dense-only recall separate the tokeniser from the embedder. Stage latencies at
  p50 and p95 catch tokeniser cost.
- **Write path.** Run the observe path on translated turns. Report language preservation (the
  writer's `lang`, checked against the turn's language), date-resolution accuracy (written
  ISO days against the expected days) and Jev agreement (§8).

**Bars.**

| Check                                  | Bar                                                     |
| -------------------------------------- | ------------------------------------------------------- |
| English, tokeniser v2                  | `recall-golden.json` identical; demo eval unchanged     |
| Gating languages, mono, cloud models   | recall@10 ≥ 0.9 × English                               |
| Gating languages, cross-lingual        | recall@10 ≥ 0.75 × English mono                         |
| Gating languages, `abstainFp`          | ≤ English + 0.1                                         |
| Writer language preservation           | ≥ 98% per gating language                               |
| Writer date resolution                 | ≥ 95% per gating language                               |
| Jev agreement                          | ≥ 90% per gating language                               |

**How it runs.** Lexical-only and fake-embedder runs are deterministic, so they run in CI on
every change to the tokeniser. Real-model runs need keys and run by hand:
`pnpm --filter @oortmem/bench run eval -- --set multilingual --embed voyage --rerank voyage`, or
`--embed local:multilingual-e5-small`. Results are recorded in `docs/cli.md`, like today's
calibrations. The same runs calibrate the per-embedder `minDenseScore` for cross-lingual pairs
(§4.3).

## 12. Phases

**0.6.0 (launch).** Nothing from this spec.

**0.6.x: low risk, cloud first.** The cloud runs released core, so each item reaches it with a
core release and a dependency bump.

1. **Measure first.** Ship the multilingual eval set and a baseline run, both for the cloud's
   models and for local ones. This answers the main open fact: is `voyage-3.5-lite` good enough
   per language?
2. Writer language rule (§7). It is a prompt change, with no data migration.
3. Prompt gate fixes (§10).
4. Tokeniser v2, the FTS5 declaration and the index rebuild: local schema version 4, and the
   cloud's batched rebuild (§5, §14). It ships only if the English golden test is identical.
5. A docs note on date-cue fallback for non-English text (§6.1).

**0.7 (0.7.x if it does not fit the 0.7.0 window).**

1. The `language` setting: config, `oort language`, the dashboard toggle, the account and
   organisation default, `oort setup` and the SDK option (§3).
2. `multilingual-e5-small` in the catalog, with `auto`'s detection and suggestion (§4), closing
   CON-96's multilingual part.
3. Writer `lang`, `validFrom` and `validTo` (§6.2, §7).
4. The cross-lingual relevance gate and per-embedder `minDenseScore` calibration (§4.3).
5. chrono locales and the extended date prefilter (§6.3).
6. Jev agreement measurement, plus the ADD bias for any language that misses (§8).
7. Scrub keywords, a width-aware injection budget and Latin stopwords (§5.1, §10).

**Later.**

- A Voyage 4 series fleet migration, if the eval shows the lite model lagging (§9.3).
- A small multilingual local reranker, `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (§15),
  calibrated like MiniLM.
- Per-locale temporal intent for the tracked languages.
- A Claude-based decision controller, only if Jev misses widely.

## 13. Open questions, with recommended answers

1. **Default for new installs: `auto` or `en`?** `auto`. It changes nothing for English users,
   whose model and behaviour stay the same, and it surfaces the switch for everyone else.
2. **Should local `auto` download e5 without asking?** No. Ask once, in an interactive command or
   `oort setup`, and treat `multi` as consent. Hooks never download.
3. **Should Oort Cloud move off `voyage-3.5-lite` now?** No. Decide after the 0.6.x baseline. If
   it moves, move the whole fleet to the Voyage 4 series (§9.3), never per account.
4. **Should memories be translated to English?** No (§7).
5. **Which language does an UPDATE use when the prior memory differs?** The current turn's (§7).
6. **Should Latin diacritics be folded in tokeniser v2?** Yes, both when indexing and when
   querying. Unaccented typing is common in Spanish, Portuguese and French chat.
7. **Korean: bigrams or space-separated words?** Bigrams. Particles attach to words (`서비스는`),
   and bigrams match through them. The eval confirms or reverts.
8. **Account or organisation precedence in the cloud?** An explicit account value, then the
   organisation default, then `auto`.
9. **Local reranker in `multi`?** None in hooks (`fast` mode is the default anyway). Keep
   `bge-reranker-v2-m3` as an opt-in for `oort mcp`. Add the small mMiniLM reranker later.
10. **Thai segmentation drift across ICU versions?** Accept it, record ICU's major version and
    rebuild when a newer major meets segmented text (§5.2).

## 14. Oort Cloud operational notes (may move to the private repo)

- **Same tokeniser string today.** Each account's store creates `memories_fts` with the same
  `unicode61` declaration as `store-sqlite`, and indexes core's `tokenizeLexical` output. It has
  the same bug, and it gets the same fix.
- **Rebuild.** Ship it as a numbered schema migration that creates `memories_fts_v2` and sets a
  `lexical_version` cursor, in the same release that bumps core to tokeniser v2 (§5.2). A
  background task then re-inserts rows in batches of a few thousand, between requests, so no
  request runs long. When it finishes, it drops the old `memories_fts`, keeps `memories_fts_v2` as
  the index's name (renaming it back would let an older build write v1 tokens into it unnoticed)
  and runs `optimize`. Until the cursor completes, lexical queries search both tables, each with its own
  tokenisation, and merge by best rank. Shared-node legs do the same with their own cursor, since
  every node tokenises queries with the deployed core. The rebuild makes no vendor calls; it
  writes rows only.
- **Setting storage.** Store `language` as a column on the account record, default `auto`, and
  as an organisation default on the organisation record. The account's store reads it with the
  rest of its configuration when the account loads. It affects the gate, date locales and rerank
  routing only, never the embedding model.
- **Allow-list.** Phase 0.6.x and 0.7 need no change: `voyage-3.5-lite`, `rerank-3-lite` and
  `rerank-2.5-lite`, `claude-haiku-5-5` and `jev-latest`. The Voyage 4 series would need an
  allow-list change and a cost review before §9.3.
- **Embedder binding before any model change.** Cloud stores assume a fixed space today (512 int8,
  `voyage-3.5-lite`), with no recorded binding. Add a per-store binding, as `store-sqlite` has,
  before any fleet migration. A leg whose binding differs from the query's model then answers
  lexically only, instead of returning meaningless dense hits.
- **Metering.** The cross-lingual rerank in `fast` mode (§4.3) adds rerank calls for those
  queries. Count them in the usage dashboard like any rerank.

## 15. Appendix: model and library sources

| Item                                   | Source (pinned)                                                       | Size                         | Licence                     | Languages / notes                                           |
| -------------------------------------- | --------------------------------------------------------------------- | ---------------------------- | --------------------------- | ----------------------------------------------------------- |
| multilingual-e5-small (ONNX)           | `Xenova/multilingual-e5-small` @ `761b726d…`, `onnx/model_int8.onnx` (SHA-256 `4d24e2bc…`) | 118,054,593 B + tokenizer 17,082,730 B (`0b44a9d7…`) | Upstream `intfloat/multilingual-e5-small`: MIT. The Xenova repo states no licence of its own; confirm before shipping | 100 languages from XLM-R, "low-resource languages may see performance degradation"; 12 layers, 384 dims, 512 tokens; `query: ` / `passage: ` prefixes; mean pooling |
| multilingual-e5-small (upstream ONNX)  | `intfloat/multilingual-e5-small` @ `614241f6…`, `onnx/model_qint8_avx512_vnni.onnx` | 118,346,824 B         | MIT                         | An x86-tuned quantisation; the Xenova int8 export is portable |
| mMiniLM reranker (later)               | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` @ `1427fd65…`, `onnx/model_qint8_arm64.onnx` (and `model_quint8_avx2.onnx` for x64) | 118,620,017 B + tokenizer 17,082,660 B | Apache-2.0 | Trained on mMARCO (MS MARCO machine-translated into 14 languages), the same data lineage as today's MiniLM default; needs per-architecture files in the catalog |
| bge-reranker-v2-m3 (in catalog)        | `onnx-community/bge-reranker-v2-m3-ONNX` @ `6f5ff652…`                | 570,727,094 B                | Apache-2.0                  | Multilingual; `size: 'large'`; uncalibrated (`scale 1, shift 0`) |
| jina-reranker-v2-base-multilingual     | `jinaai/jina-reranker-v2-base-multilingual`                           | 279,577,152 B (int8)         | CC-BY-NC-4.0                | Rejected: non-commercial                                    |
| chrono-node                            | npm `chrono-node` 2.10.3                                              | 3.5 MB (CJS dist)            | MIT                         | Locales: en de fr ja pt nl zh ru es uk it sv fi vi id ar    |
| Language ID                            | See §4.2                                                              |                              |                             | Not adopted                                                 |

Vendor documentation read on 2026-11-06:

- Voyage: [embeddings](https://docs.voyageai.com/docs/embeddings),
  [reranker](https://docs.voyageai.com/docs/reranker),
  [batch inference](https://docs.voyageai.com/docs/batch-inference),
  [voyage-3.5 post](https://blog.voyageai.com/2025/05/20/voyage-3-5/) and
  [rerank-3 post](https://blog.voyageai.com/2026/09/30/rerank-3/).
- TypeSafe: [llms.txt](https://docs.typesafe.ai/llms.txt),
  [models](https://docs.typesafe.ai/models.md),
  [changelog](https://docs.typesafe.ai/changelog.md) and
  [model jaggedness](https://docs.typesafe.ai/model-jaggedness.md).
- Anthropic:
  [multilingual support](https://platform.claude.com/docs/en/build-with-claude/multilingual-support).
- SQLite: [FTS5](https://sqlite.org/fts5.html), §4.3.1 (unicode61) and §4.3.4 (trigram).
- Model cards: [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small),
  [mE5 report](https://arxiv.org/abs/2402.05672),
  [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) and
  [mmarco-mMiniLMv2](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1).
- franc: [readme](https://github.com/wooorm/franc).
