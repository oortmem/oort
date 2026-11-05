/**
 * The models Oort can run locally. Each file is pinned to a Hugging Face commit and a SHA-256,
 * so a pull is reproducible and a tampered or truncated download is refused.
 *
 * The defaults are small on purpose: every Claude Code hook is a new process, so a model is
 * loaded from disk once per prompt. Measured on an Apple M1 Max (single thread, CPU time):
 * bge-small loads in about 110 ms (22 ms from the optimised cache) and embeds a query in 6 ms;
 * the MiniLM reranker loads in about 60 ms (13 ms cached) and scores 16 short documents in
 * 110 ms. The large models load in 0.8 to 1 s, need over 1 GB of RAM, and suit the long-lived
 * `oort mcp` server rather than per-prompt hooks.
 */

export type ModelRole = 'embed' | 'rerank' | 'decide';

/** One file of a model: where it comes from in the repo, and what it must hash to. */
export interface ModelFile {
  /** The local file name inside the model's directory. */
  name: 'model.onnx' | 'tokenizer.json' | 'tokenizer_config.json';
  /** Path inside the Hugging Face repository. */
  path: string;
  bytes: number;
  sha256: string;
}

interface BaseSpec {
  /** The id `embed.model` / `rerank.model` names, and the directory under `~/.oort/models`. */
  id: string;
  role: ModelRole;
  /** One line for `oort models`. */
  label: string;
  /** `small` loads fast enough for hooks; `large` is for the long-lived MCP server. */
  size: 'small' | 'large';
  /** The ONNX conversion that is downloaded, pinned to a commit. */
  source: { repo: string; revision: string };
  /** The original model the conversion was made from. */
  upstream: string;
  /** SPDX id of the model weights' licence (all allow commercial use). */
  licence: string;
  files: readonly ModelFile[];
  /** Longest input in tokens, special tokens included. */
  maxTokens: number;
}

export interface EmbedModelSpec extends BaseSpec {
  role: 'embed';
  /** The width of the model's own embedding. */
  nativeDimension: number;
  /** `cls`: the first token; `mean`: masked mean; `last`: the last real token. */
  pooling: 'cls' | 'mean' | 'last';
  /** Trained with Matryoshka loss, so a prefix of the embedding is itself an embedding. */
  matryoshka: boolean;
  queryPrefix: string;
  documentPrefix: string;
  /** A decoder export that takes (empty) past key/value inputs. */
  kvCache?: { layers: number; heads: number; headDim: number };
}

export interface RerankModelSpec extends BaseSpec {
  role: 'rerank';
  /**
   * The score is `sigmoid(scale * logit + shift)`. MS MARCO cross-encoders emit uncalibrated
   * logits (unrelated pairs sit near -10); this maps them onto the 0 to 1 range that
   * `recall.minRerankScore` (0.35) was set for. Provisional until calibrated on the eval.
   */
  calibration: { scale: number; shift: number };
}

export interface DecideModelSpec extends BaseSpec {
  role: 'decide';
  /** The decoder's key/value cache inputs. */
  kvCache: { layers: number; heads: number; headDim: number };
  /**
   * The chat format the prompt is written in. `chatml-nothink` is ChatML with an empty
   * `<think></think>` block opening the answer (Qwen3 with thinking off).
   */
  template: 'chatml' | 'chatml-nothink';
  /**
   * Log-odds added to each yes-or-no answer before it is read at 0.5: small models lean towards
   * "yes" (or "no") whatever the question. Fitted per model on packages/bench/eval/decisions.jsonl
   * (docs/local-decider.md); a question without an entry is read as the model answers it.
   */
  calibration: Partial<Record<DecideQuestion, number>>;
}

/** The yes-or-no questions of the local decider (gate, novel, and the reconcile tree). */
export type DecideQuestion =
  | 'should_store'
  | 'volatile'
  | 'novel'
  | 'related'
  | 'conflict'
  | 'mistake'
  | 'newinfo'
  | 'samefact';

export type ModelSpec = EmbedModelSpec | RerankModelSpec | DecideModelSpec;

const HF_TOKENIZER_JSON_BERT_UNCASED = {
  name: 'tokenizer.json',
  path: 'tokenizer.json',
  bytes: 711_396,
  sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
} as const;

export const MODELS: readonly ModelSpec[] = [
  {
    id: 'bge-small-en-v1.5',
    role: 'embed',
    label: 'BGE small, English (int8, 34 MB)',
    size: 'small',
    source: {
      repo: 'Xenova/bge-small-en-v1.5',
      revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    },
    upstream: 'BAAI/bge-small-en-v1.5',
    licence: 'MIT',
    files: [
      {
        name: 'model.onnx',
        path: 'onnx/model_int8.onnx',
        bytes: 33_760_831,
        sha256: 'bf64d05457cb391fa88d045faf5927a15ea36d96228ddf23ea970087afdc1197',
      },
      HF_TOKENIZER_JSON_BERT_UNCASED,
      {
        name: 'tokenizer_config.json',
        path: 'tokenizer_config.json',
        bytes: 366,
        sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
      },
    ],
    maxTokens: 512,
    nativeDimension: 384,
    pooling: 'cls',
    matryoshka: false,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    documentPrefix: '',
  },
  {
    id: 'ms-marco-minilm-l6-v2',
    role: 'rerank',
    label: 'MS MARCO MiniLM-L6 cross-encoder, English (int8, 23 MB)',
    size: 'small',
    source: {
      repo: 'Xenova/ms-marco-MiniLM-L-6-v2',
      revision: 'a09144355adeed5f58c8ed011d209bf8ee5a1fec',
    },
    upstream: 'cross-encoder/ms-marco-MiniLM-L6-v2',
    licence: 'Apache-2.0',
    files: [
      {
        name: 'model.onnx',
        path: 'onnx/model_int8.onnx',
        bytes: 23_012_404,
        sha256: 'a13ec391ca99f49886694e12d3e800521f36d4267d7d448c34421c541a2baf50',
      },
      HF_TOKENIZER_JSON_BERT_UNCASED,
      {
        name: 'tokenizer_config.json',
        path: 'tokenizer_config.json',
        bytes: 1_242,
        sha256: '0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53',
      },
    ],
    maxTokens: 512,
    calibration: { scale: 0.5, shift: 2.4 },
  },
  {
    id: 'qwen3-embedding-0.6b',
    role: 'embed',
    label: 'Qwen3 Embedding 0.6B, multilingual (int8, 614 MB; slow to load, for oort mcp)',
    size: 'large',
    source: {
      repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
      revision: 'c25a394dd583836952667c12f008335071b3f43d',
    },
    upstream: 'Qwen/Qwen3-Embedding-0.6B',
    licence: 'Apache-2.0',
    files: [
      {
        name: 'model.onnx',
        path: 'onnx/model_int8.onnx',
        bytes: 613_527_539,
        sha256: '6d0ea863f78b4a84afa3c7fcba1ec341572b5e28121aef77b7092b1dfdf679c7',
      },
      {
        name: 'tokenizer.json',
        path: 'tokenizer.json',
        bytes: 11_423_705,
        sha256: 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a',
      },
      {
        name: 'tokenizer_config.json',
        path: 'tokenizer_config.json',
        bytes: 9_731,
        sha256: '977648852447cb6587327ff3205b0a84cf2fc9f05621d6c8e88a497caafab2e1',
      },
    ],
    maxTokens: 1024,
    nativeDimension: 1024,
    pooling: 'last',
    matryoshka: true,
    queryPrefix:
      'Instruct: Given a question about a software project, retrieve the note that answers it\nQuery:',
    documentPrefix: '',
    kvCache: { layers: 28, heads: 8, headDim: 128 },
  },
  {
    id: 'bge-reranker-v2-m3',
    role: 'rerank',
    label: 'BGE reranker v2 m3, multilingual (int8, 571 MB; slow, for oort mcp)',
    size: 'large',
    source: {
      repo: 'onnx-community/bge-reranker-v2-m3-ONNX',
      revision: '6f5ff65298512715a1e669753bc754d2bc8f367b',
    },
    upstream: 'BAAI/bge-reranker-v2-m3',
    licence: 'Apache-2.0',
    files: [
      {
        name: 'model.onnx',
        path: 'onnx/model_int8.onnx',
        bytes: 570_727_094,
        sha256: '912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d',
      },
      {
        name: 'tokenizer.json',
        path: 'tokenizer.json',
        bytes: 17_082_900,
        sha256: '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3',
      },
      {
        name: 'tokenizer_config.json',
        path: 'tokenizer_config.json',
        bytes: 1_203,
        sha256: 'b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80',
      },
    ],
    maxTokens: 512,
    calibration: { scale: 1, shift: 0 },
  },
  {
    // Decisions only (CON-16). Qwen3 0.6B, Qwen2.5 0.5B and SmolLM2 class models were measured
    // and do not tell the answers apart; this is the smallest that does (docs/local-decider.md).
    id: 'qwen2.5-1.5b-instruct',
    role: 'decide',
    label: 'Qwen2.5 1.5B Instruct, decisions (int4, 1.8 GB; loaded by the background drain)',
    size: 'large',
    source: {
      repo: 'onnx-community/Qwen2.5-1.5B-Instruct',
      revision: 'd54957e3af1be04546436e874a60fe386041b244',
    },
    upstream: 'Qwen/Qwen2.5-1.5B-Instruct',
    licence: 'Apache-2.0',
    files: [
      {
        name: 'model.onnx',
        path: 'onnx/model_q4.onnx',
        bytes: 1_787_566_590,
        sha256: '70c24509f760fed9a8f50391165c46a87660197028a42c4547763f1c173ddea6',
      },
      {
        name: 'tokenizer.json',
        path: 'tokenizer.json',
        bytes: 7_031_673,
        sha256: 'a8506e7111b80c6d8635951a02eab0f4e1a8e4e5772da83846579e97b16f61bf',
      },
      {
        name: 'tokenizer_config.json',
        path: 'tokenizer_config.json',
        bytes: 7_849,
        sha256: '6a14243f0ae04884e597b3f032c05e15de9f417318fdcac24ab4e2680e691430',
      },
    ],
    maxTokens: 4096,
    kvCache: { layers: 28, heads: 2, headDim: 128 },
    template: 'chatml',
    // pnpm eval --decisions --fit (docs/local-decider.md).
    calibration: {
      should_store: -4.09,
      volatile: 2.33,
      novel: -0.5,
      related: 5.44,
      conflict: -0.46,
      mistake: -2.75,
      newinfo: 0.94,
      samefact: 0.55,
    },
  },
];

export const DEFAULT_EMBED_MODEL = 'bge-small-en-v1.5';
export const DEFAULT_RERANK_MODEL = 'ms-marco-minilm-l6-v2';
export const DEFAULT_DECIDE_MODEL = 'qwen2.5-1.5b-instruct';

/** The catalog entry for `id`, or undefined. */
export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Total download size of `spec` in bytes. */
export function downloadBytes(spec: ModelSpec): number {
  return spec.files.reduce((n, f) => n + f.bytes, 0);
}
