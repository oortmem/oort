# @oortmem/local-models

Embeddings, reranking and (optionally) save decisions for Oort on this machine's CPU, through ONNX Runtime. No API keys, no account, and no network after the one-time download.

```sh
npm install -g oortmem @oortmem/local-models
oort models pull     # downloads the default models (58 MB) into ~/.oort/models and switches to them
```

| Role   | Default                 | Size  | Licence    | Upstream                            |
| ------ | ----------------------- | ----- | ---------- | ----------------------------------- |
| embed  | `bge-small-en-v1.5`     | 34 MB | MIT        | BAAI/bge-small-en-v1.5              |
| rerank | `ms-marco-minilm-l6-v2` | 23 MB | Apache-2.0 | cross-encoder/ms-marco-MiniLM-L6-v2 |

Larger multilingual models (`qwen3-embedding-0.6b`, `bge-reranker-v2-m3`, about 600 MB each) are available with `oort models pull <id>`; they take about a second to load, so they suit `oort mcp` better than per-prompt hooks.

### Decisions (optional, large)

```sh
oort models pull qwen2.5-1.5b-instruct   # 1.8 GB; sets decide.provider to "local"
```

| Role   | Model                   | Size   | Licence    | Upstream                   |
| ------ | ----------------------- | ------ | ---------- | -------------------------- |
| decide | `qwen2.5-1.5b-instruct` | 1.8 GB | Apache-2.0 | Qwen/Qwen2.5-1.5B-Instruct |

The local decider answers the gate questions Jev answers (worth storing, salience, type, volatile) with one forward pass per question, reading the probability of a one-word answer; nothing is generated, so it is deterministic. It never rewrites or ends a memory by default: a fact about the same thing as an existing memory is added beside it. Only the background drain loads it, never a prompt hook. Saving still needs a writer key (Anthropic or Oort Pro): there is no local writer. Measurements and the reasons are in [docs/local-decider.md](../../docs/local-decider.md).

Every file is pinned to a Hugging Face commit and its SHA-256, checked before it is kept. Models are never downloaded during a hook or a recall, only by `oort models pull` or `oort setup`.

```ts
import { localDecider, localEmbedder, localReranker } from '@oortmem/local-models';

const embed = localEmbedder({ home: '/path/to/.oort', dimension: 512 });
const rerank = localReranker({ home: '/path/to/.oort' });
const decide = localDecider({ home: '/path/to/.oort' }); // a DecisionController
```

Runtime dependencies: [onnxruntime-node](https://github.com/microsoft/onnxruntime) (MIT) and [@huggingface/tokenizers](https://github.com/huggingface/tokenizers.js) (Apache-2.0).

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. See the [main README](https://github.com/oortmem/oort#readme) for how the pieces fit. Apache-2.0.
