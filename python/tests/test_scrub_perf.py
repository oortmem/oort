"""The scrubber must run in time linear in its input (the TypeScript one does: 200 KB in well under
a second). Each input below is the shape of a quadratic: a lookbehind emulation that searched from
the start of the text per candidate took minutes on ``":" * 200_000``. The limit is generous so a
loaded CI machine cannot flake it; a quadratic misses it by orders of magnitude."""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from oortmem._scrub import scrub  # noqa: E402

SIZE = 200_000
LIMIT_SECONDS = 2.0

CASES = {
    "colons": ":" * SIZE,
    "timestamps": "12:30:45 INFO ok\n" * (SIZE // 17),
    "pem begins": "-----BEGIN PRIVATE KEY-----\n" * (SIZE // 28),
    "jwt dots": "eyJ" + "a." * (SIZE // 2),
    "escaped quotes": '\\"' * (SIZE // 2),
    "crlf": "x\r\n" * (SIZE // 3),
    "scheme runs": "a://" * (SIZE // 4),
    "basic-auth flags": "-u a:" * (SIZE // 5),
    "redaction markers": "[REDACTED:a]" * (SIZE // 12),
    "dots": "." * SIZE,
}


class ScrubPerformance(unittest.TestCase):
    def test_linear_time(self) -> None:
        for name, text in CASES.items():
            with self.subTest(name):
                start = time.perf_counter()
                scrub(text)
                took = time.perf_counter() - start
                self.assertLess(took, LIMIT_SECONDS, f"{name}: {took:.2f}s for {len(text)} chars")

    def test_pem_pairing_matches_the_regex(self) -> None:
        key = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"
        self.assertEqual(scrub(f"a {key} b -----BEGIN PRIVATE KEY-----").text, "a [REDACTED:pem-private-key] b -----BEGIN PRIVATE KEY-----")
        # overlapping markers: the trailing dashes of one BEGIN start the next
        two = "-----BEGIN PRIVATE KEY-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----"
        self.assertEqual(scrub(two).text, "[REDACTED:pem-private-key]")


if __name__ == "__main__":
    unittest.main()
