"""Builds the tiny ONNX models and tokenizer the tests run against (a few kB, committed).

Run with the `onnx` package installed: python3 scripts/make-test-models.py
Re-running rewrites test/fixtures/tiny-embed and test/fixtures/tiny-rerank (then run prettier on them).

The embedder maps each token to a fixed 8-dim "topic" vector (Gather), so mean pooling gives
texts on the same topic similar embeddings. The reranker scores a (query, document) pair by how
concentrated the masked mean of those vectors is: a pair on one topic scores high, a mixed pair
low. Neither is a language model; they exercise the real runtime, tokenizer and pooling code.
"""

import json
import os

import onnx
from onnx import TensorProto, helper, numpy_helper
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "test", "fixtures")

SPECIAL = ["[PAD]", "[UNK]", "[CLS]", "[SEP]"]
TOPICS = [
    ["oort", "setup", "demo", "word", "nebula"],
    ["database", "backups", "kept", "days", "retained", "long"],
    ["port", "search", "runs", "locally", "listens", "development"],
    ["vitest", "test", "framework", "tests"],
]
STOP = ["the", "is", "what", "for", "on", "in", "we", "use", "which", "how", "are", "do", "our"]
VOCAB = SPECIAL + [w for t in TOPICS for w in t] + STOP
DIM = 8


def table() -> np.ndarray:
    e = np.zeros((len(VOCAB), DIM), dtype=np.float32)
    for i, w in enumerate(VOCAB):
        if w == "[PAD]":
            continue
        topic = next((k for k, t in enumerate(TOPICS) if w in t), None)
        if topic is not None:
            e[i, topic] = 1.0
        else:
            e[i, 7] = 0.2  # specials and stop words: a small shared direction
    return e


def inputs():
    return [
        helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"]),
        helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "seq"]),
        helper.make_tensor_value_info("token_type_ids", TensorProto.INT64, ["batch", "seq"]),
    ]


def save(model: onnx.ModelProto, name: str) -> None:
    model.producer_name = "oort-test-fixture"
    onnx.checker.check_model(model)
    d = os.path.join(FIXTURES, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "model.onnx"), "wb") as f:
        f.write(model.SerializeToString())
    with open(os.path.join(d, "tokenizer.json"), "w") as f:
        json.dump(tokenizer_json(), f, indent=1)
        f.write("\n")
    with open(os.path.join(d, "tokenizer_config.json"), "w") as f:
        json.dump(
            {"do_lower_case": True, "model_max_length": 64, "tokenizer_class": "BertTokenizer"},
            f,
            indent=1,
        )
        f.write("\n")


def embed_model() -> onnx.ModelProto:
    e = numpy_helper.from_array(table(), "E")
    nodes = [
        # token_type_ids joins in as zeros, so every declared input is consumed.
        helper.make_node("Cast", ["token_type_ids"], ["tt_f"], to=TensorProto.FLOAT),
        helper.make_node("Unsqueeze", ["tt_f", "axis2"], ["tt_3d"]),
        helper.make_node("Mul", ["tt_3d", "zero"], ["tt_zero"]),
        helper.make_node("Gather", ["E", "input_ids"], ["g"]),
        helper.make_node("Add", ["g", "tt_zero"], ["last_hidden_state"]),
    ]
    graph = helper.make_graph(
        nodes,
        "tiny_embed",
        inputs(),
        [helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, ["batch", "seq", DIM])],
        [
            e,
            numpy_helper.from_array(np.array([2], dtype=np.int64), "axis2"),
            numpy_helper.from_array(np.array(0.0, dtype=np.float32), "zero"),
        ],
    )
    # attention_mask is declared like a BERT export's and left unused: pooling reads it in JS.
    return helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)


def rerank_model() -> onnx.ModelProto:
    e = numpy_helper.from_array(table(), "E")
    nodes = [
        helper.make_node("Gather", ["E", "input_ids"], ["g"]),
        helper.make_node("Cast", ["attention_mask"], ["mask_f"], to=TensorProto.FLOAT),
        helper.make_node("Unsqueeze", ["mask_f", "axis2"], ["mask3"]),
        helper.make_node("Mul", ["g", "mask3"], ["gm"]),
        helper.make_node("ReduceSum", ["gm", "axis1"], ["sum"], keepdims=0),
        helper.make_node("ReduceSum", ["mask_f", "axis1"], ["count"], keepdims=1),
        helper.make_node("Div", ["sum", "count"], ["mean"]),
        helper.make_node("Mul", ["mean", "mean"], ["sq"]),
        helper.make_node("ReduceSum", ["sq", "axis1"], ["conc"], keepdims=1),
        helper.make_node("Mul", ["conc", "scale"], ["scaled"]),
        helper.make_node("Add", ["scaled", "shift"], ["logits"]),
    ]
    graph = helper.make_graph(
        nodes,
        "tiny_rerank",
        inputs(),
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, ["batch", 1])],
        [
            e,
            numpy_helper.from_array(np.array([2], dtype=np.int64), "axis2"),
            numpy_helper.from_array(np.array([1], dtype=np.int64), "axis1"),
            numpy_helper.from_array(np.array(12.0, dtype=np.float32), "scale"),
            numpy_helper.from_array(np.array(-4.0, dtype=np.float32), "shift"),
        ],
    )
    return helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)


def tokenizer_json() -> dict:
    vocab = {w: i for i, w in enumerate(VOCAB)}
    special = lambda w: {  # noqa: E731
        "id": vocab[w],
        "content": w,
        "single_word": False,
        "lstrip": False,
        "rstrip": False,
        "normalized": False,
        "special": True,
    }
    return {
        "version": "1.0",
        "truncation": None,
        "padding": None,
        "added_tokens": [special(w) for w in SPECIAL],
        "normalizer": {
            "type": "BertNormalizer",
            "clean_text": True,
            "handle_chinese_chars": True,
            "strip_accents": None,
            "lowercase": True,
        },
        "pre_tokenizer": {"type": "BertPreTokenizer"},
        "post_processor": {
            "type": "TemplateProcessing",
            "single": [
                {"SpecialToken": {"id": "[CLS]", "type_id": 0}},
                {"Sequence": {"id": "A", "type_id": 0}},
                {"SpecialToken": {"id": "[SEP]", "type_id": 0}},
            ],
            "pair": [
                {"SpecialToken": {"id": "[CLS]", "type_id": 0}},
                {"Sequence": {"id": "A", "type_id": 0}},
                {"SpecialToken": {"id": "[SEP]", "type_id": 0}},
                {"Sequence": {"id": "B", "type_id": 1}},
                {"SpecialToken": {"id": "[SEP]", "type_id": 1}},
            ],
            "special_tokens": {
                w: {"id": w, "ids": [vocab[w]], "tokens": [w]} for w in ["[CLS]", "[SEP]"]
            },
        },
        "decoder": {"type": "WordPiece", "prefix": "##", "cleanup": True},
        "model": {
            "type": "WordPiece",
            "unk_token": "[UNK]",
            "continuing_subword_prefix": "##",
            "max_input_chars_per_word": 100,
            "vocab": vocab,
        },
    }


if __name__ == "__main__":
    save(embed_model(), "tiny-embed")
    save(rerank_model(), "tiny-rerank")
    print("wrote", FIXTURES)
