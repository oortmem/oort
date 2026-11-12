# Baseline: LoCoMo and LongMemEval_S, links off (2026-11-12)

Retrieval-level baselines for the memory relationships bar (design
`docs/design/2026-11-12-memory-relationships.md`, section 11; CON-147). Method, sources and
licences are in `../eval/public/README.md`. Recall is as in Oort 0.9.0 (bench package 0.9.0),
with today's defaults (relevance gate on, `returnK` 10) and links off. Tables are copied as
printed.

| Set                                        | Revision                                                                | SHA-256          |
| ------------------------------------------ | ----------------------------------------------------------------------- | ---------------- |
| LoCoMo `locomo10.json`                     | snap-research/locomo@3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376           | `79fa87e9…98ff4` |
| LongMemEval_S `longmemeval_s_cleaned.json` | xiaowu0162/longmemeval-cleaned@98d7416c24c778c2fee6e6f3006e7a073259d48f | `d6f21ea9…3a442` |

Models: local `bge-small-en-v1.5` (512 dimensions) and `ms-marco-minilm-l6-v2`, as pulled by
`oort models pull`. Voyage was not run (see the plan below).

## LoCoMo (10 conversations, 5,882 turns, 1,981 questions)

Evidence recall over turns. 5 questions have no evidence id that names a turn and are left out;
3 such references were dropped from other questions.

| Path                     | overall r@10 | single-hop (841) | multi-hop (282) | temporal (320) | open-domain (92) | adversarial (446) |
| ------------------------ | ------------ | ---------------- | --------------- | -------------- | ---------------- | ----------------- |
| lexical                  | 0.407        | 0.488            | 0.161           | 0.527          | 0.130            | 0.382             |
| fast: bge-small          | 0.564        | 0.650            | 0.325           | 0.668          | 0.262            | 0.540             |
| full: bge-small + MiniLM | 0.499        | 0.635            | 0.296           | 0.575          | 0.129            | 0.393             |

Full tables:

`pnpm eval --set locomo` (lexical):

| Group       | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ----------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall     | 1981 | 0.401    | 0.407     | 0.352  | -          | -          | -              |
| single-hop  | 841  | 0.480    | 0.488     | 0.405  | -          | -          | -              |
| multi-hop   | 282  | 0.151    | 0.161     | 0.219  | -          | -          | -              |
| temporal    | 320  | 0.516    | 0.527     | 0.422  | -          | -          | -              |
| open-domain | 92   | 0.130    | 0.130     | 0.137  | -          | -          | -              |
| adversarial | 446  | 0.381    | 0.382     | 0.328  | -          | -          | -              |

`pnpm eval --set locomo --embed local` (`fast`):

| Group       | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ----------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall     | 1981 | 0.492    | 0.564     | 0.400  | -          | -          | -              |
| single-hop  | 841  | 0.574    | 0.650     | 0.447  | -          | -          | -              |
| multi-hop   | 282  | 0.238    | 0.325     | 0.333  | -          | -          | -              |
| temporal    | 320  | 0.624    | 0.668     | 0.513  | -          | -          | -              |
| open-domain | 92   | 0.231    | 0.262     | 0.202  | -          | -          | -              |
| adversarial | 446  | 0.460    | 0.540     | 0.315  | -          | -          | -              |

`pnpm eval --set locomo --embed local --rerank local` (`full`):

| Group       | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ----------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall     | 1981 | 0.486    | 0.499     | 0.467  | -          | -          | -              |
| single-hop  | 841  | 0.623    | 0.635     | 0.562  | -          | -          | -              |
| multi-hop   | 282  | 0.266    | 0.296     | 0.404  | -          | -          | -              |
| temporal    | 320  | 0.569    | 0.575     | 0.552  | -          | -          | -              |
| open-domain | 92   | 0.123    | 0.129     | 0.157  | -          | -          | -              |
| adversarial | 446  | 0.380    | 0.393     | 0.331  | -          | -          | -              |

The reranker raises MRR (0.400 to 0.467) but lowers recall@10 (0.564 to 0.499): the relevance gate
on rerank scores returns fewer than 10 memories on many questions. That is today's recall
behaving as configured, and it is the baseline, but it is worth knowing when reading a links-on
run of the `full` path. Multi-hop is the category links are meant to move: 0.161 to 0.325
recall@10 today depending on the path.

## LongMemEval_S

### All 500 questions, lexical

`pnpm eval --set longmemeval`: 500 haystacks, 124,354 rounds (4 dropped by the secret scrubber).

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

Recall over answer sessions:

| Group                     | Rows | recall@5 | recall@10 | MRR@10 | Stale-leak | Abstain FP | Link precision |
| ------------------------- | ---- | -------- | --------- | ------ | ---------- | ---------- | -------------- |
| overall                   | 470  | 0.566    | 0.566     | 0.659  | -          | -          | -              |
| multi-session             | 121  | 0.508    | 0.508     | 0.703  | -          | -          | -              |
| temporal-reasoning        | 127  | 0.316    | 0.316     | 0.449  | -          | -          | -              |
| knowledge-update          | 72   | 0.868    | 0.868     | 0.938  | -          | -          | -              |
| single-session-user       | 64   | 0.922    | 0.922     | 0.904  | -          | -          | -              |
| single-session-assistant  | 56   | 0.661    | 0.661     | 0.661  | -          | -          | -              |
| single-session-preference | 30   | 0.200    | 0.200     | 0.178  | -          | -          | -              |

Stale-leak 0.771 on knowledge-update means the outdated round came back in the top 10 on most of
those questions. Verbatim storage never supersedes, so this measures retrieval over raw rounds,
not Oort's update handling.

### 50 questions spread through the file, lexical and bge-small

`pnpm eval --set longmemeval --limit 50` takes every tenth question, so all categories appear; the
local embedder run over all 124,358 rounds did not fit this session's machine time. The lexical
50 match the full run overall (turn recall@10 0.495 both), which suggests the sample is
representative, but per-category rows of 3 to 12 questions are noisy.

| Path            | turn r@10 | session r@10 | multi-session r@10 (12) | temporal r@10 (12) | KU stale-leak (7) | abstain FP (4) |
| --------------- | --------- | ------------ | ----------------------- | ------------------ | ----------------- | -------------- |
| lexical         | 0.495     | 0.574        | 0.438                   | 0.292              | 0.714             | 0.750          |
| fast: bge-small | 0.659     | 0.738        | 0.514                   | 0.389              | 0.857             | 0.750          |

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
| overall                   | 46   | 0.574    | 0.574     | 0.670  | -          | -          | -              |
| multi-session             | 12   | 0.590    | 0.590     | 0.750  | -          | -          | -              |
| temporal-reasoning        | 12   | 0.358    | 0.358     | 0.583  | -          | -          | -              |
| knowledge-update          | 7    | 0.857    | 0.857     | 0.929  | -          | -          | -              |
| single-session-user       | 7    | 0.714    | 0.714     | 0.619  | -          | -          | -              |
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
| overall                   | 46   | 0.738    | 0.738     | 0.799  | -          | -          | -              |
| multi-session             | 12   | 0.611    | 0.611     | 0.667  | -          | -          | -              |
| temporal-reasoning        | 12   | 0.511    | 0.511     | 0.750  | -          | -          | -              |
| knowledge-update          | 7    | 0.929    | 0.929     | 1.000  | -          | -          | -              |
| single-session-user       | 7    | 0.857    | 0.857     | 0.857  | -          | -          | -              |
| single-session-assistant  | 5    | 1.000    | 1.000     | 1.000  | -          | -          | -              |
| single-session-preference | 3    | 1.000    | 1.000     | 0.583  | -          | -          | -              |

## Voyage: plan only

`--plan` counts with Voyage's published tokenizer (exact for documents and queries; upper bounds
for query requests and rerank calls). Nothing was sent.

| Set           | Embed: texts / requests / tokens | Embed: query tokens (at most) | Rerank: calls / tokens (at most) | Cost at list price, at most    |
| ------------- | -------------------------------- | ----------------------------- | -------------------------------- | ------------------------------ |
| LoCoMo        | 5,880 / 46 / 204,043             | 24,586                        | 1,981 / 5,446,190                | $0.0046 embed + $0.1089 rerank |
| LongMemEval_S | 96,077 / 751 / 39,592,704        | 9,027                         | 500 / 11,379,442                 | $0.7920 embed + $0.2276 rerank |

Prices are $0.02 per million tokens for voyage-3.5-lite and rerank-3-lite (Voyage list prices,
2026-11-12); an account's free allowance lowers the real cost.
