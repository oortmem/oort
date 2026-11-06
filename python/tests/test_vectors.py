"""The golden vectors the TypeScript SDK writes (packages/cli/src/sdk/python.test.ts) and both SDKs
check: ``format_for_prompt`` character for character, Oort Cloud's refusals as typed errors, and
the daemon's error envelope as typed errors."""

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
