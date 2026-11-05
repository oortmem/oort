# @oortmem/local-models

Embeddings and reranking for Oort on this machine's CPU, through ONNX Runtime. No API keys, no account, and no network after the one-time download.

```sh
npm install -g oortmem @oortmem/local-models
oort models pull     # downloads the default models (58 MB) into ~/.oort/models and switches to them
```

| Role   | Default                 | Size  | Licence    | Upstream                            |
| ------ | ----------------------- | ----- | ---------- | ----------------------------------- |
| embed  | `bge-small-en-v1.5`     | 34 MB | MIT        | BAAI/bge-small-en-v1.5              |
| rerank | `ms-marco-minilm-l6-v2` | 23 MB | Apache-2.0 | cross-encoder/ms-marco-MiniLM-L6-v2 |

Larger multilingual models (`qwen3-embedding-0.6b`, `bge-reranker-v2-m3`, about 600 MB each) are available with `oort models pull <id>`; they take about a second to load, so they suit `oort mcp` better than per-prompt hooks.

Every file is pinned to a Hugging Face commit and its SHA-256, checked before it is kept. Models are never downloaded during a hook or a recall, only by `oort models pull` or `oort setup`.

```ts
import { localEmbedder, localReranker } from '@oortmem/local-models';

const embed = localEmbedder({ home: '/path/to/.oort', dimension: 512 });
const rerank = localReranker({ home: '/path/to/.oort' });
```

Runtime dependencies: [onnxruntime-node](https://github.com/microsoft/onnxruntime) (MIT) and [@huggingface/tokenizers](https://github.com/huggingface/tokenizers.js) (Apache-2.0).

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. See the [main README](https://github.com/oortmem/oort#readme) for how the pieces fit. Apache-2.0.
