"""The SDK contract suite's Python runner (CON-108 section 10): the JSON cases in
``contract/sdk/cases`` that the TypeScript runner runs, run through ``oortmem.Oort``.

It is started once per case by ``packages/cli/src/sdk/python.test.ts``, which owns the fakes: a
fixture ``oort serve`` with deterministic models (local) and the shared fake Oort Cloud (cloud).
The harness passes the case on argv and answers two requests on stdin and stdout, one JSON line
each: ``{"step": n}`` before each step (it sets that step's forced cloud failures) and
``{"reader": id}`` for a ``reader.judgment`` step (a 0.5.x-style read of the store).

Results are compared in their wire shape (``to_wire``: camelCase, absent fields left out), so one
file of expectations serves both SDKs. A ``TypeError`` for an unknown keyword argument counts as
the TypeScript SDK's ``usage`` error for an unknown field: Python refuses it before any I/O too.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "python", "src"))

from oortmem import Oort, format_for_prompt  # noqa: E402
from oortmem.errors import OortError, error_shape  # noqa: E402
from oortmem.types import RecallResult, from_wire, snake, to_wire  # noqa: E402

CONTRACT = os.path.join(ROOT, "contract", "sdk")
DEFAULT_NOW = "2026-11-05T12:00:00.000Z"


def _secrets() -> List[Dict[str, str]]:
    out = []
    path = os.path.join(ROOT, "packages", "core", "test", "fixtures", "secrets.b64.txt")
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            kind, b64 = line.split("\t", 1)
            secret, *rest = base64.b64decode(b64).decode("utf-8").split("\t")
            out.append({"kind": kind, "secret": secret, "text": "\t".join(rest)})
    return out


SECRETS = _secrets()


def _secret_text(kind: str) -> str:
    for s in SECRETS:
        if s["kind"] == kind:
            return s["text"]
    raise KeyError(kind)


def substitute(v: Any, saved: Dict[str, Any]) -> Any:
    if isinstance(v, str):
        whole = re.fullmatch(r"\$\{([^}]+)\}", v)
        if whole and not whole.group(1).startswith("secret:") and whole.group(1) in saved:
            return saved[whole.group(1)]

        def rep(m: "re.Match[str]") -> str:
            name = m.group(1)
            if name.startswith("secret:"):
                return _secret_text(name[7:])
            if name.startswith("repeat:"):
                r = re.fullmatch(r"repeat:(\d+):(.*)", name)
                return (r.group(2) if r else "x") * int(r.group(1) if r else 0)
            return str(saved[name]) if name in saved else m.group(0)

        return re.sub(r"\$\{([^}]+)\}", rep, v)
    if isinstance(v, list):
        return [substitute(x, saved) for x in v]
    if isinstance(v, dict):
        return {k: substitute(x, saved) for k, x in v.items()}
    return v


def pick(v: Any, p: str) -> Any:
    cur = v
    for part in re.findall(r"\.[^.[]+|\[\d+\]", re.sub(r"^\$", "", p)):
        if cur is None:
            return None
        cur = cur[int(part[1:-1])] if part.startswith("[") else cur.get(part[1:])
    return cur


_MISSING = object()


def type_of(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def matches(actual: Any, expected: Any, at: str, problems: List[str]) -> None:
    if isinstance(expected, dict):
        ops = [k for k in expected if k.startswith("$")]
        if ops:
            for op in ops:
                x = expected[op]
                if op == "$type":
                    t = "undefined" if actual is _MISSING else type_of(actual)
                    if t != x:
                        problems.append(f"{at}: type {t}, not {x}")
                elif op == "$len":
                    n = len(actual) if isinstance(actual, (list, str)) else None
                    if n != x:
                        problems.append(f"{at}: length {n}, not {x}")
                elif op in ("$some", "$every", "$none"):
                    if not isinstance(actual, list):
                        problems.append(f"{at}: not an array")
                        continue
                    ok = []
                    for i, a in enumerate(actual):
                        p: List[str] = []
                        matches(a, x, f"{at}[{i}]", p)
                        ok.append(not p)
                    if op == "$some" and not any(ok):
                        problems.append(f"{at}: no element matches")
                    if op == "$every" and not all(ok):
                        problems.append(f"{at}: an element differs")
                    if op == "$none" and any(ok):
                        problems.append(f"{at}: an element matches")
                elif op == "$absent":
                    if actual is not _MISSING and actual is not None:
                        problems.append(f"{at}: present")
                elif op == "$regex":
                    if not isinstance(actual, str) or not re.search(_js_regex(str(x)), actual):
                        problems.append(f"{at}: {actual!r} does not match /{x}/")
                elif op == "$approx":
                    tol = expected.get("$tol", 1e-6)
                    if not isinstance(actual, (int, float)) or abs(actual - x) > tol:
                        problems.append(f"{at}: {actual} is not about {x}")
                elif op == "$tol":
                    pass
                else:
                    problems.append(f"{at}: unknown matcher {op}")
            return
        if not isinstance(actual, dict):
            problems.append(f"{at}: {actual!r} is not an object")
            return
        for k, x in expected.items():
            matches(actual.get(k, _MISSING), x, f"{at}.{k}", problems)
        return
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            problems.append(f"{at}: {actual!r} is not an array of {len(expected)}")
            return
        for i, x in enumerate(expected):
            matches(actual[i], x, f"{at}[{i}]", problems)
        return
    if actual is _MISSING:
        actual = None if expected is None else actual
    if actual != expected or type(actual) is bool and type(expected) is not bool:
        problems.append(f"{at}: {actual!r}, not {expected!r}")


def _js_regex(src: str) -> str:
    # JavaScript and Python agree on the patterns the cases use; [\s\S] and (?!...) included.
    return src


def kwargs(args: Dict[str, Any]) -> Dict[str, Any]:
    return {snake(k): v for k, v in args.items()}


def ask(msg: Dict[str, Any]) -> Any:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()
    return json.loads(sys.stdin.readline())


def call(o: Oort, step: Dict[str, Any], args: Dict[str, Any], now: datetime) -> Any:
    c = step["call"]
    a = dict(args)
    if c == "recall":
        q = a.pop("query")
        return o.recall(q, **kwargs(a))
    if c == "observe":
        return o.observe(a)
    if c == "remember":
        facts = a.pop("facts")
        return o.remember(facts, **kwargs(a))
    if c == "forget":
        i = a.pop("id")
        return o.forget(i, **kwargs(a))
    if c in ("pin", "unpin", "explain"):
        return getattr(o, c)(a["id"])
    if c in ("link", "unlink"):
        return getattr(o, c)(a["from"], a["to"])
    if c == "recent":
        return o.recent(**kwargs(a))
    if c == "whoami":
        return o.whoami()
    if c == "consolidate":
        return o.consolidate(**kwargs(a))
    if c == "scoped":
        return o.scoped(**kwargs(a))
    if c == "endUsers.erase":
        return o.end_users.erase(a["user"])
    if c == "endUsers.export":
        return o.end_users.export(a["user"])
    if c == "endUsers.count":
        return o.end_users.count()
    if c == "judge.record":
        return o.judge.record(**kwargs(a))
    if c == "judge.apply":
        item = a.pop("item")
        return o.judge.apply(item, **kwargs(a))
    if c == "judge.list":
        return o.judge.list(**kwargs(a))
    if c == "judge.confirm":
        return o.judge.confirm(a["id"])
    if c == "formatForPrompt":
        r = a.pop("result")
        res = r if isinstance(r, RecallResult) else from_wire(RecallResult, r)
        return format_for_prompt(res, now=now, **kwargs(a))
    raise ValueError(f"unknown call {c}")


def expect_no_secret(v: Any) -> None:
    text = json.dumps(v, default=str, ensure_ascii=False)
    for s in SECRETS:
        if len(s["secret"]) >= 8 and s["secret"] in text:
            raise AssertionError(f"a fixture secret ({s['kind']}) came back in a result")


def shape(e: BaseException) -> Dict[str, Any]:
    if isinstance(e, TypeError):
        # Python refuses an unknown keyword before any I/O, as the SDK refuses an unknown field.
        return {"name": "OortUsageError", "code": "usage", "reason": "invalid-argument", "message": str(e)}
    return error_shape(e)


def main() -> int:
    spec = json.loads(sys.argv[1])
    case = spec["case"]
    transport = spec["transport"]
    now_iso = case.get("now") or DEFAULT_NOW
    now = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    now_ms = now.timestamp() * 1000
    saved: Dict[str, Any] = {}
    options = substitute(case.get("options") or {}, saved)
    kw: Dict[str, Any] = {}
    for k, v in options.items():
        if k == "config":
            continue  # local: the harness wrote it to the daemon's home config
        if k == "judge":
            kw["judge_role"] = v["role"]
            if "operator" in v:
                kw["operator"] = v["operator"]
            continue
        kw[snake(k)] = v
    env = {"HOME": spec["root"], "OORT_HOME": spec["home"], "OORT_NO_KEYCHAIN": "1", "PATH": os.environ.get("PATH", "")}
    if transport == "local":
        def make() -> Oort:
            return Oort(mode="local", cwd=spec["cwd"], env=env, autostart=False, **kw)
    else:
        if not (case.get("cloud") or {}).get("noKey"):
            env["OORT_API_KEY"] = spec["key"]

        def make() -> Oort:
            return Oort(
                mode="cloud",
                cwd=spec["cwd"],
                url=spec["url"],
                env=env,
                key_sources=["env"],
                _internals={"now": lambda: now_ms},
                **kw,
            )

    problems: List[str] = []
    if "expectCreate" in case:
        try:
            make().whoami()
        except (OortError, TypeError) as e:
            matches(shape(e), substitute(case["expectCreate"]["error"], saved), "$", problems)
        else:
            problems.append("creating the handle was expected to fail")
        return report(problems)

    try:
        o = make()
    except (OortError, TypeError) as e:
        return report([f"creating the handle failed: {shape(e)}"])
    handles = {"root": o}
    try:
        for i, step in enumerate(case["steps"]):
            what = f"step {i} ({step['call']})"
            ask({"step": i})
            args = substitute(step.get("args") or {}, saved)
            result: Any = None
            error: Optional[BaseException] = None
            try:
                if step["call"] == "reader.judgment":
                    result = ask({"reader": args["id"]})
                else:
                    h = handles.get(step.get("on", "root"))
                    if h is None:
                        raise AssertionError(f"{what}: no handle named {step.get('on')}")
                    result = call(h, step, args, now)
            except (OortError, TypeError) as e:
                error = e
            if step.get("as") is not None and result is not None:
                handles[step["as"]] = result
            expected = substitute(step.get("expect") or {}, saved)
            if error is not None:
                expect_no_secret(shape(error))
                if "error" not in expected:
                    problems.append(f"{what} threw {shape(error)}")
                    break
                p: List[str] = []
                matches(shape(error), expected["error"], "$", p)
                problems += [f"{what} error: {x}" for x in p]
                continue
            if "error" in expected:
                problems.append(f"{what} was expected to fail, got {str(to_wire(result))[:300]}")
                break
            wire = result if step["call"] in ("formatForPrompt", "reader.judgment", "scoped") else to_wire(result)
            if step["call"] != "scoped":
                expect_no_secret(wire)
            if "result" in expected:
                p = []
                matches(wire, expected["result"], "$", p)
                if p:
                    problems += [f"{what} result: {x}" for x in p]
                    problems.append(f"actual: {json.dumps(wire, default=str)[:1500]}")
            for name, path in (step.get("save") or {}).items():
                saved[name] = result if path == "$" else pick(wire, path)
    finally:
        o.close()
    return report(problems)


def report(problems: List[str]) -> int:
    sys.stdout.write(json.dumps({"done": True, "problems": problems}) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
