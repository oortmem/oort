# Baseline: LongMemEval_S, links off (2026-11-12)

Retrieval-level baseline for the memory relationships bar (design
`docs/design/2026-11-12-memory-relationships.md`, section 11; CON-147). Method, source and
licence are in `../eval/public/README.md`. Recall is as in Oort 0.9.0 (bench package 0.9.0,
code at #111's head), with today's defaults (relevance gate on, `returnK` 10) and links off.
Tables are copied as printed.

LongMemEval_S is the public set. LoCoMo is supported by the same harness but is local only
(its licence is CC BY-NC 4.0), so no LoCoMo numbers are recorded here.

| Set                                        | Revision                                                                | SHA-256          |
| ------------------------------------------ | ----------------------------------------------------------------------- | ---------------- |
| LongMemEval_S `longmemeval_s_cleaned.json` | xiaowu0162/longmemeval-cleaned@98d7416c24c778c2fee6e6f3006e7a073259d48f | `d6f21ea9…3a442` |

Model for the `fast` run: local `bge-small-en-v1.5` (512 dimensions), as pulled by
`oort models pull`. Voyage was not run (see the plan below).

Two scores. Turn recall@k: the rounds holding the answer among the top k returned rounds.
Session recall@k: the answer sessions among the sessions of the top k returned rounds. On
knowledge-update, only the latest answer session (and its rounds) is expected; earlier answer
sessions (and their rounds) count toward stale-leak.

## All 500 questions, lexical

`pnpm eval --set longmemeval`: 500 haystacks, 124,354 rounds (4 dropped by the secret scrubber).

Turns:

| Group                     | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ------------------------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall                   | 500  | 0.481    | 0.495     | 0.466  | 0.771      | 0.700      | -              |
| multi-session             | 121  | 0.356    | 0.387     | 0.479  | -          | -          | -              |
| temporal-reasoning        | 127  | 0.265    | 0.269     | 0.325  | -          | -          | -              |
| knowledge-update          | 72   | 0.806    | 0.819     | 0.488  | 0.771      | -          | -              |
| single-session-user       | 64   | 0.875    | 0.875     | 0.775  | -          | -          | -              |
| single-session-assistant  | 56   | 0.571    | 0.589     | 0.565  | -          | -          | -              |
| single-session-preference | 30   | 0.117    | 0.117     | 0.111  | -          | -          | -              |
| abstention                | 30   | -        | -         | -      | -          | 0.700      | -              |

Sessions:

| Group                     | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ------------------------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall                   | 470  | 0.562    | 0.567     | 0.616  | 0.857      | -          | -              |
| multi-session             | 121  | 0.490    | 0.508     | 0.703  | -          | -          | -              |
| temporal-reasoning        | 127  | 0.314    | 0.316     | 0.449  | -          | -          | -              |
| knowledge-update          | 72   | 0.875    | 0.875     | 0.657  | 0.857      | -          | -              |
| single-session-user       | 64   | 0.922    | 0.922     | 0.900  | -          | -          | -              |
| single-session-assistant  | 56   | 0.661    | 0.661     | 0.661  | -          | -          | -              |
| single-session-preference | 30   | 0.200    | 0.200     | 0.178  | -          | -          | -              |

Stale-leak on knowledge-update (0.771 over rounds, 0.857 over sessions) means an outdated answer
came back in the top 10 on most of those questions. Verbatim storage never supersedes, so this
measures retrieval over raw rounds, not Oort's update handling.

## 50 questions spread through the file, lexical and bge-small

`pnpm eval --set longmemeval --limit 50` takes every tenth question, so every category appears.
The local embedder over all 124,358 rounds did not fit this session's machine time. Per-category
rows of 3 to 12 questions are noisy.

| Path            | turn r@10 | session r@10 | multi-session turn r@10 (12) | temporal turn r@10 (12) | KU turn stale-leak (7) | abstain FP (4) |
| --------------- | --------- | ------------ | ---------------------------- | ----------------------- | ---------------------- | -------------- |
| lexical         | 0.495     | 0.574        | 0.438                        | 0.292                   | 0.714                  | 0.750          |
| fast: bge-small | 0.659     | 0.749        | 0.514                        | 0.389                   | 0.857                  | 0.750          |

The lexical 50 match the full run overall (turn recall@10 0.495 both; session 0.574 against
0.567).

`--limit 50`, lexical, turns:

| Group                     | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ------------------------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall                   | 50   | 0.484    | 0.495     | 0.508  | 0.714      | 0.750      | -              |
| multi-session             | 12   | 0.396    | 0.438     | 0.611  | -          | -          | -              |
| temporal-reasoning        | 12   | 0.292    | 0.292     | 0.438  | -          | -          | -              |
| knowledge-update          | 7    | 0.857    | 0.857     | 0.512  | 0.714      | -          | -              |
| single-session-user       | 7    | 0.714    | 0.714     | 0.600  | -          | -          | -              |
| single-session-assistant  | 5    | 0.600    | 0.600     | 0.600  | -          | -          | -              |
| single-session-preference | 3    | 0.000    | 0.000     | 0.000  | -          | -          | -              |
| abstention                | 4    | -        | -         | -      | -          | 0.750      | -              |

Sessions:

| Group                     | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ------------------------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall                   | 46   | 0.569    | 0.574     | 0.630  | 0.857      | -          | -              |
| multi-session             | 12   | 0.590    | 0.590     | 0.750  | -          | -          | -              |
| temporal-reasoning        | 12   | 0.342    | 0.358     | 0.583  | -          | -          | -              |
| knowledge-update          | 7    | 0.857    | 0.857     | 0.679  | 0.857      | -          | -              |
| single-session-user       | 7    | 0.714    | 0.714     | 0.607  | -          | -          | -              |
| single-session-assistant  | 5    | 0.800    | 0.800     | 0.800  | -          | -          | -              |
| single-session-preference | 3    | 0.000    | 0.000     | 0.000  | -          | -          | -              |

`--limit 50 --embed local` (`fast`), turns:

| Group                     | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ------------------------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall                   | 50   | 0.625    | 0.659     | 0.613  | 0.857      | 0.750      | -              |
| multi-session             | 12   | 0.424    | 0.514     | 0.521  | -          | -          | -              |
| temporal-reasoning        | 12   | 0.389    | 0.389     | 0.486  | -          | -          | -              |
| knowledge-update          | 7    | 0.857    | 0.857     | 0.500  | 0.857      | -          | -              |
| single-session-user       | 7    | 0.857    | 0.857     | 0.857  | -          | -          | -              |
| single-session-assistant  | 5    | 1.000    | 1.000     | 1.000  | -          | -          | -              |
| single-session-preference | 3    | 0.667    | 0.833     | 0.537  | -          | -          | -              |
| abstention                | 4    | -        | -         | -      | -          | 0.750      | -              |

Sessions:

| Group                     | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ------------------------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall                   | 46   | 0.701    | 0.749     | 0.749  | 0.857      | -          | -              |
| multi-session             | 12   | 0.611    | 0.611     | 0.667  | -          | -          | -              |
| temporal-reasoning        | 12   | 0.494    | 0.511     | 0.750  | -          | -          | -              |
| knowledge-update          | 7    | 0.857    | 1.000     | 0.694  | 0.857      | -          | -              |
| single-session-user       | 7    | 0.857    | 0.857     | 0.857  | -          | -          | -              |
| single-session-assistant  | 5    | 1.000    | 1.000     | 1.000  | -          | -          | -              |
| single-session-preference | 3    | 0.667    | 1.000     | 0.537  | -          | -          | -              |

## Voyage: plan only

`pnpm eval --set longmemeval --embed voyage --rerank voyage --plan`, counted with Voyage's
published tokenizer: exact for documents and query tokens, upper bounds for query requests and
rerank calls. Nothing was sent.

| Embed: texts / requests / tokens | Embed: query tokens (at most) | Rerank: calls / tokens (at most) | Cost at list price, at most    |
| -------------------------------- | ----------------------------- | -------------------------------- | ------------------------------ |
| 96,077 / 751 / 39,592,704        | 9,027                         | 500 / 11,379,442                 | $0.7920 embed + $0.2276 rerank |

Prices are $0.02 per million tokens for voyage-3.5-lite and rerank-3-lite (Voyage list prices,
2026-11-12); an account's free allowance lowers the real cost.
