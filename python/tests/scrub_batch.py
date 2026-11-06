"""Reads a JSON list of strings on stdin and writes each one's scrub result as JSON on stdout:
``[[text, secretRatio, [[kind, count], ...]], ...]``. The TypeScript parity test
(packages/cli/src/sdk/python.test.ts) runs the shared secret corpus through this and through
core's ``scrub`` and requires identical output."""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

from oortmem._scrub import scrub  # noqa: E402

out = []
for s in json.load(sys.stdin):
    r = scrub(s)
    out.append([r.text, r.secret_ratio, [[x.kind, x.count] for x in r.redactions]])
json.dump(out, sys.stdout)
