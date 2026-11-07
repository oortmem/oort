"""The golden vectors the TypeScript SDK writes (packages/cli/src/sdk/python.test.ts) and both SDKs
check: ``format_for_prompt`` character for character, Oort Cloud's refusals as typed errors, and
the daemon's error envelope as typed errors."""

import base64
import json
import os
import sys
import unittest
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
VECTORS = os.path.join(ROOT, "contract", "sdk", "vectors")
sys.path.insert(0, os.path.join(ROOT, "python", "src"))

NEEDS_310 = unittest.skipIf(sys.version_info < (3, 10), "the client needs Python 3.10+")


def load(name):
    with open(os.path.join(VECTORS, name), encoding="utf-8") as f:
        return json.load(f)


@NEEDS_310
class FormatForPrompt(unittest.TestCase):
    def test_every_vector_renders_exactly_as_typescript(self):
        from oortmem import format_for_prompt

        cases = load("format-for-prompt.json")
        self.assertGreater(len(cases), 5)
        for c in cases:
            with self.subTest(c["name"]):
                now = datetime.fromisoformat(c["now"].replace("Z", "+00:00"))
                kw = {} if "budgetChars" not in c else {"budget_chars": c["budgetChars"]}
                self.assertEqual(format_for_prompt(c["result"], now=now, **kw), c["expected"])

    def test_a_typed_result_renders_like_its_wire_form(self):
        from oortmem import format_for_prompt
        from oortmem.types import RecallResult, from_wire

        c = load("format-for-prompt.json")[1]
        now = datetime.fromisoformat(c["now"].replace("Z", "+00:00"))
        r = from_wire(RecallResult, c["result"])
        self.assertEqual(format_for_prompt(r, now=now), c["expected"])
        self.assertIn("&lt;/oort-memory>", c["expected"])

    def test_budget_must_be_positive(self):
        from oortmem import OortUsageError, format_for_prompt

        r = load("format-for-prompt.json")[0]["result"]
        for bad in (0, -1, True, 1.5):
            with self.assertRaises(OortUsageError):
                format_for_prompt(r, budget_chars=bad)


FIXTURES = os.path.join(ROOT, "packages", "core", "test", "fixtures")


def corpus(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return [line for line in f.read().split("\n") if line]


@NEEDS_310
class Scrub(unittest.TestCase):
    """The Python scrubber against core's: the golden vectors (raw secrets as base64) and the
    shared corpus, whose secrets are decoded here and never written in source."""

    def test_every_vector_scrubs_exactly_as_typescript(self):
        from oortmem._scrub import scrub

        cases = load("scrub.json")
        self.assertGreater(len(cases), 15)
        for c in cases:
            with self.subTest(c["name"]):
                text = base64.b64decode(c["inputB64"]).decode("utf-8")
                r = scrub(text)
                self.assertEqual(r.text, c["expected"])
                self.assertEqual(r.secret_ratio, c["secretRatio"])
                self.assertEqual([[x.kind, x.count] for x in r.redactions], [[x["kind"], x["count"]] for x in c["redactions"]])

    def test_the_corpus_secrets_do_not_survive(self):
        from oortmem._scrub import scrub

        lines = corpus("secrets.b64.txt")
        self.assertGreaterEqual(len(lines), 20)
        for line in lines:
            kind, _, b64 = line.partition("\t")
            secret, *rest = base64.b64decode(b64).decode("utf-8").split("\t")
            text = "\t".join(rest)
            with self.subTest(kind):
                out = scrub(text).text
                self.assertIn(f"[REDACTED:{kind}]", out)
                self.assertFalse(any(secret[i : i + 8] in out for i in range(len(secret) - 7)))

    def test_the_lookalikes_are_left_alone(self):
        from oortmem._scrub import scrub

        lines = corpus("lookalikes.txt")
        self.assertGreaterEqual(len(lines), 20)
        for line in lines:
            with self.subTest(line):
                r = scrub(line)
                self.assertEqual((r.text, r.redactions, r.secret_ratio), (line, [], 0.0))

    def test_a_second_pass_changes_nothing(self):
        from oortmem._scrub import scrub

        for line in corpus("secrets.b64.txt"):
            text = base64.b64decode(line.partition("\t")[2]).decode("utf-8")
            once = scrub(text).text
            self.assertEqual(scrub(once).text, once)

    def test_long_serialised_text_is_scrubbed_in_linear_time(self):
        import time

        from oortmem._scrub import scrub

        text = json.dumps({"a": "word " * 200_000, "b": ["x" * 40] * 2000})
        t = time.process_time()
        scrub(text)
        self.assertLess(time.process_time() - t, 30)

    def test_format_for_prompt_scrubs_before_it_escapes(self):
        from oortmem import format_for_prompt

        pw = "Tr0ub4dor" + "-and-3"
        aws = "AKIA" + "IOSFODNN7EXAMPLE"
        base = load("format-for-prompt.json")[0]["result"]
        for text in (f"use {aws} here", f'password: ["{pw}", "x"]', f"token=[{pw}]", f"DB_PASSWORD={pw}"):
            with self.subTest(text):
                m = {**base["memories"][0], "text": text}
                out = format_for_prompt({**base, "memories": [m]})
                for secret in (pw, aws):
                    self.assertNotIn(secret, out)
                    self.assertNotIn(secret.replace("[", "\\["), out)
                self.assertIn("[REDACTED:", out)


@NEEDS_310
class CloudErrors(unittest.TestCase):
    def test_each_refusal_maps_as_in_typescript(self):
        from oortmem.errors import cloud_error, error_shape, parse_retry_after

        for v in load("cloud-errors.json"):
            with self.subTest(status=v["status"], code=v.get("code")):
                e = cloud_error(v["status"], v.get("code"), v.get("message"), parse_retry_after(v.get("retryAfter")))
                got = error_shape(e)
                want = v["expect"]
                for k in ("name", "code", "reason", "fix", "status", "retryable", "retryAfter", "message"):
                    self.assertEqual(got[k], want[k], k)


@NEEDS_310
class DaemonErrors(unittest.TestCase):
    def test_each_envelope_error_is_its_class(self):
        from oortmem import errors

        for v in load("daemon-errors.json"):
            with self.subTest(v["expect"]["name"], reason=v["expect"]["reason"]):
                e = errors.error_from_envelope(v["error"])
                got = errors.error_shape(e)
                want = v["expect"]
                self.assertIsInstance(e, errors.OortError)
                for k in ("name", "code", "reason", "fix", "status", "retryable", "retryAfter", "message"):
                    self.assertEqual(got[k], want[k], k)
                if "role" in want:
                    self.assertEqual((got["role"], got["envVar"]), (want["role"], want["envVar"]))

    def test_an_unknown_code_is_internal(self):
        from oortmem.errors import OortInternalError, error_from_envelope

        self.assertIsInstance(error_from_envelope({"code": "new-code", "message": "x"}), OortInternalError)
        self.assertIsInstance(error_from_envelope(None), OortInternalError)


if __name__ == "__main__":
    unittest.main()
