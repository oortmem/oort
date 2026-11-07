"""The scrubber must run in time linear in its input (the TypeScript one does: 200 KB in well under
a second). Each input below is the shape of a quadratic: a lookbehind emulation that searched from
the start of the text per candidate took minutes on ``":" * 200_000``. The limit is generous so a
loaded CI machine cannot flake it; a quadratic misses it by orders of magnitude."""

import os
import random
import sys
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

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


class ScrubThreadSafety(unittest.TestCase):
    """The scrubber keeps no shared mutable state: concurrent calls give single-threaded results."""

    def test_concurrent_calls_match_serial_results(self) -> None:
        rng = random.Random(11)
        parts = [
            "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----",
            "curl -u bob:hunter2xyz https://x", "-u a:b", "token=abcdefghijklmnop12345", "http://u:pw@host/",
            '{"password":"s3cretvalue99"}', "ABCdef0123456789ABCdef0123456789xyzQ", "plain words here\n", ":", "[REDACTED:a]",
            "\\n", "x\r\n", "eyJabcdefghijk.abcdefghijkl.abcdefghijkl",
        ]
        texts = ["".join(rng.choice(parts) for _ in range(rng.randint(1, 25))) for _ in range(400)]
        serial = [scrub(t) for t in texts]
        interval = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)  # switch threads as often as possible
        try:
            with ThreadPoolExecutor(max_workers=8) as pool:
                for _ in range(5):
                    got = list(pool.map(scrub, texts))
                    self.assertEqual(got, serial)
        finally:
            sys.setswitchinterval(interval)


if __name__ == "__main__":
    unittest.main()
