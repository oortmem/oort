"""The framework examples (examples/python/langgraph_store.py, openai_agents.py, crewai_agent.py),
run end to end as written: the real, built ``oort serve`` in a throwaway home with deterministic
models (fixtures/fake-models.mjs), and each framework with its own fake model in place of the
vendor's, as examples/test/examples.test.ts does for TypeScript. No keys. A guard (``NoNetwork``:
Python-level connects and name lookups in this process) fails a test on any attempt to reach
beyond loopback.

Each framework has its own environment (``pip install --require-hashes -r
examples/python/requirements/<framework>.txt``). A framework that is not installed is skipped;
``OORT_FRAMEWORKS=langgraph`` (a comma-separated list of ``langgraph``, ``openai-agents``,
``crewai``) runs only those, and ``OORT_REQUIRE_FRAMEWORKS=1`` (CI) turns a selected one's skip
into a failure."""

import asyncio
import contextlib
import errno
import importlib.util
import io
import ipaddress
import os
import runpy
import socket
import subprocess
import threading
import time
import unittest
from unittest import mock

from test_integration import BIN, HERE, NODE, READY, ROOT, Home

EXAMPLES = os.path.join(ROOT, "examples", "python")
FAKE_MODELS = os.path.join(HERE, "fixtures", "fake-models.mjs")
REQUIRE = os.environ.get("OORT_REQUIRE_FRAMEWORKS") == "1"
ONLY = [f for f in os.environ.get("OORT_FRAMEWORKS", "").split(",") if f != ""]


def require(framework: str, *modules: str) -> None:
    """Skips a framework OORT_FRAMEWORKS leaves out. Otherwise skips (or, with
    OORT_REQUIRE_FRAMEWORKS=1, fails) unless the daemon and ``modules`` exist."""
    unknown = set(ONLY) - {"langgraph", "openai-agents", "crewai"}
    if unknown:
        raise AssertionError(f"OORT_FRAMEWORKS names no such framework: {', '.join(sorted(unknown))}")
    if ONLY and framework not in ONLY:
        raise unittest.SkipTest(f"OORT_FRAMEWORKS={','.join(ONLY)}")
    missing = [m for m in modules if importlib.util.find_spec(m) is None]
    why = None
    if not READY:
        why = "needs Python 3.10+, Node and the built CLI (pnpm build)"
    elif missing:
        why = f"{', '.join(missing)} not installed (pip install --require-hashes -r examples/python/requirements/{framework}.txt)"
    if why is not None:
        if REQUIRE:
            raise AssertionError(f"OORT_REQUIRE_FRAMEWORKS=1: {why}")
        raise unittest.SkipTest(why)


class Daemon:
    """The built ``oort serve``, in the foreground, with the SDK's model fakes in place of the
    vendor adapters. Each role still needs a key in the daemon's environment: any value."""

    def __init__(self) -> None:
        self.h = Home()
        env = dict(self.h.env)
        for name in ("VOYAGE_API_KEY", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY"):
            env[name] = "-".join(["fixture", name.split("_")[0].lower(), "unused"])
        self.proc = subprocess.Popen(
            [NODE, "--import", FAKE_MODELS, BIN, "serve"],
            env=env,
            cwd=self.h.root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.log = ""
        threading.Thread(target=self._read, daemon=True).start()
        deadline = time.monotonic() + 60
        while "listening on" not in self.log:
            if self.proc.poll() is not None or time.monotonic() > deadline:
                self.close()
                raise RuntimeError(f"oort serve did not start:\n{self.log[-3000:]}")
            time.sleep(0.05)

    def _read(self) -> None:
        for line in self.proc.stdout:
            self.log += line

    def environ(self) -> dict:
        """What an example's ``Oort()`` reads: this home, no keychain, no Oort Cloud, no key."""
        keep = {k: v for k, v in os.environ.items() if k in ("TMPDIR", "LANG", "SYSTEMROOT")}
        return {
            **keep,
            "HOME": self.h.root,
            "OORT_HOME": self.h.home,
            "OORT_NO_KEYCHAIN": "1",
            "OORT_NO_UPDATE_CHECK": "1",
            "PATH": self.h.env["PATH"],
            # The frameworks' own telemetry and tracing, off (the guard would refuse it anyway).
            "OPENAI_AGENTS_DISABLE_TRACING": "1",
            "CREWAI_DISABLE_TELEMETRY": "true",
            "CREWAI_TRACING_ENABLED": "false",
            "OTEL_SDK_DISABLED": "true",
        }

    def oort(self, **kw):
        """A handle on the same store, to look at what an example left behind."""
        from oortmem import Oort

        return Oort(mode="local", env=self.environ(), cwd=self.h.root, autostart=False, **kw)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.h.close()


class NoNetwork:
    """In this test process only, patches Python's ``socket.socket.connect`` and ``connect_ex``
    and ``socket.getaddrinfo`` to refuse (and record) anything but loopback and Unix sockets. It
    does not see native extensions that open sockets themselves, ``socket.gethostbyname``, UDP
    sends without connect, or the Node daemon (a separate process, whose models are fakes)."""

    def __init__(self) -> None:
        self.blocked: list = []

    @staticmethod
    def _local(host) -> bool:
        if host in (None, "localhost"):
            return True
        try:
            return ipaddress.ip_address(str(host).split("%")[0]).is_loopback
        except ValueError:
            return False

    def __enter__(self) -> "NoNetwork":
        real_connect, real_connect_ex, real_getaddrinfo = socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo
        guard = self

        def allowed(sock, address) -> bool:
            if sock.family == getattr(socket, "AF_UNIX", None) or guard._local(address[0]):
                return True
            guard.blocked.append(address)
            return False

        def connect(sock, address):
            if not allowed(sock, address):
                raise OSError(errno.ENETUNREACH, "no network in tests")
            return real_connect(sock, address)

        def connect_ex(sock, address):
            return real_connect_ex(sock, address) if allowed(sock, address) else errno.ENETUNREACH

        def getaddrinfo(host, *a, **kw):
            if not guard._local(host.decode() if isinstance(host, bytes) else host):
                guard.blocked.append(host)
                raise socket.gaierror(socket.EAI_NONAME, "no network in tests")
            return real_getaddrinfo(host, *a, **kw)

        self._patches = [
            mock.patch.object(socket.socket, "connect", connect),
            mock.patch.object(socket.socket, "connect_ex", connect_ex),
            mock.patch.object(socket, "getaddrinfo", getaddrinfo),
        ]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc) -> None:
        for p in reversed(self._patches):
            p.stop()


class FrameworkCase(unittest.TestCase):
    framework = ""
    modules: tuple = ()
    d: Daemon

    @classmethod
    def setUpClass(cls) -> None:
        require(cls.framework, *cls.modules)
        cls.d = Daemon()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.d.close()

    @contextlib.contextmanager
    def world(self):
        """The example's process: this home's environment, its cwd, and no network."""
        cwd = os.getcwd()
        os.chdir(self.d.h.root)
        try:
            with mock.patch.dict(os.environ, self.d.environ(), clear=True), NoNetwork() as net:
                yield
            self.assertEqual(net.blocked, [], "a network call was attempted")
        finally:
            os.chdir(cwd)

    def run_example(self, name: str, *patches) -> tuple:
        out = io.StringIO()
        with self.world(), contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            with contextlib.redirect_stdout(out):
                ns = runpy.run_path(os.path.join(EXAMPLES, name), run_name="__main__")
        return ns, out.getvalue()


class LangGraph(FrameworkCase):
    framework = "langgraph"
    modules = ("langgraph", "langchain_core", "langchain_anthropic")

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        from langchain_core.language_models.fake_chat_models import FakeListChatModel

        cls.calls = calls = []

        class ChatAnthropic(FakeListChatModel):
            """The example's ChatAnthropic, as LangChain's own fake chat model."""

            def __init__(self, **_kw) -> None:
                super().__init__(responses=["Your order number is 1042."])

            def _call(self, messages, *a, **kw):
                calls.append([f"{m.type}: {m.text}" for m in messages])
                return super()._call(messages, *a, **kw)

        cls.ChatAnthropic = ChatAnthropic

    def setUp(self) -> None:
        if not hasattr(type(self), "ns"):
            type(self).ns, type(self).out = self.run_example(
                "langgraph_store.py", mock.patch("langchain_anthropic.ChatAnthropic", self.ChatAnthropic)
            )

    def store(self):
        o = self.d.oort(org="acme", project=None, project_config=False)
        self.addCleanup(o.close)
        return self.ns["OortStore"](o, self.ns["user_scope"])  # the example's own scope

    def test_a_put_remembers_and_the_node_recalls_then_observes(self) -> None:
        self.assertEqual(self.out, "Your order number is 1042.\n")
        [sent] = self.calls
        self.assertTrue(sent[0].startswith("system: You help customers.\n<oort-memory>\n"), sent[0])
        self.assertIn("My order number is 1042.", sent[0])
        self.assertEqual(sent[1], "human: What is my order number?")
        o = self.d.oort(org="acme", project=None, project_config=False)
        self.addCleanup(o.close)
        ada = [m.text for m in o.scoped(user="user-ada").recent(limit=10).memories]
        self.assertCountEqual(ada, ["My order number is 1042.", "What is my order number?"])  # put, then observe
        self.assertEqual(o.scoped(user="user-bob").recent(limit=10).memories, [])
        self.assertEqual(self.d.oort().recent(limit=10).memories, [])  # never the person's own memory

    def test_b_search_get_delete_by_oort_id(self) -> None:
        from langgraph.store.base import Item, SearchItem

        from oortmem import OortUsageError

        store, ns = self.store(), ("user-cy",)
        store.put(ns, "drink", {"text": "Cy prefers tea over coffee."})
        [hit] = store.search(ns, query="does Cy prefer tea or coffee")
        self.assertIsInstance(hit, SearchItem)
        self.assertNotEqual(hit.key, "drink")  # Oort assigns the id; the put key is not kept
        self.assertEqual((hit.namespace, hit.value), (ns, {"text": "Cy prefers tea over coffee."}))
        self.assertIsInstance(hit.score, float)
        self.assertEqual(store.search(ns), [])  # no query: Oort lists by relevance only
        got = store.get(ns, hit.key)
        self.assertIsInstance(got, Item)
        self.assertEqual((got.key, got.value), (hit.key, hit.value))
        self.assertIsNotNone(got.created_at.tzinfo)
        self.assertIsNone(store.get(("user-dan",), hit.key))  # another user's: not found
        self.assertIsNone(store.get(ns, "99999999-0000-4000-8000-000000000009"))
        self.assertEqual(store.list_namespaces(), [])
        store.delete(ns, hit.key)  # a None put: forget
        self.assertIsNone(store.get(ns, hit.key))
        self.assertEqual(store.search(ns, query="does Cy prefer tea or coffee"), [])
        with self.assertRaises(TypeError):
            store.put(ns, "note", {"note": "not text"})
        with self.assertRaises(NotImplementedError):
            store.put(ns, "note", {"text": "Cy is away in May."}, ttl=60)  # LangGraph: no TTL support
        with self.assertRaises(NotImplementedError):
            store.search(ns, query="tea", filter={"kind": "drink"})
        with self.assertRaises(OortUsageError):
            store.search(ns, query="tea", limit=51)  # recall takes 1 to 50
        # Any namespace but (user_id,) is refused, never read as some user (or as no one).
        for bad in [(), ("",), ("memories", "user-cy"), ("user-cy", "notes")]:
            with self.assertRaises(ValueError, msg=bad):
                store.search(bad, query="tea")
        with self.assertRaises(ValueError):
            store.put(("memories", "user-cy"), "k", {"text": "LangMem's namespace shape"})

    def test_c_each_user_reads_and_forgets_only_their_own(self) -> None:
        from oortmem import OortNotFoundError

        store, fay, gus = self.store(), ("user-fay",), ("user-gus",)
        store.put(fay, "code", {"text": "My locker code is 4410."})
        store.put(gus, "code", {"text": "My locker code is 7782."})
        q = "what is my locker code"
        self.assertEqual([i.value["text"] for i in store.search(fay, query=q)], ["My locker code is 4410."])
        self.assertEqual([i.value["text"] for i in store.search(gus, query=q)], ["My locker code is 7782."])
        [mine] = store.search(fay, query=q)
        self.assertIsNone(store.get(gus, mine.key))  # another user's id: not found, as unknown
        with self.assertRaises(OortNotFoundError):
            store.delete(gus, mine.key)
        self.assertEqual(store.get(fay, mine.key).value, {"text": "My locker code is 4410."})

    def test_d_abatch_runs_in_order(self) -> None:
        from langgraph.store.base import GetOp, PutOp, SearchOp

        store, ns = self.store(), ("user-eve",)
        put, [hit], missing = asyncio.run(
            store.abatch(
                [
                    PutOp(ns, "k", {"text": "Eve's invoices go to finance@example.org."}),
                    SearchOp(ns, query="where do Eve's invoices go"),
                    GetOp(ns, "99999999-0000-4000-8000-000000000009"),
                ]
            )
        )
        self.assertIsNone(put)
        self.assertEqual(hit.value, {"text": "Eve's invoices go to finance@example.org."})
        self.assertIsNone(missing)
        self.assertEqual(asyncio.run(store.aget(ns, hit.key)).key, hit.key)
        asyncio.run(store.adelete(ns, hit.key))
        self.assertIsNone(store.get(ns, hit.key))


class OpenAIAgents(FrameworkCase):
    framework = "openai-agents"
    modules = ("agents",)

    def test_recalls_into_the_instructions_then_observes(self) -> None:
        from agents.items import ModelResponse
        from agents.models.interface import Model
        from agents.models.multi_provider import MultiProvider
        from agents.usage import Usage
        from openai.types.responses import ResponseOutputMessage, ResponseOutputText

        with self.d.oort() as o:
            o.remember("We deploy the billing service on Fridays.")
        seen = []

        class ScriptedModel(Model):
            """Answers once, and keeps the instructions it was given."""

            async def get_response(self, system_instructions, input, *a, **kw):  # noqa: A002
                seen.append(system_instructions)
                text = ResponseOutputText(type="output_text", text="Billing deploys on Fridays.", annotations=[])
                msg = ResponseOutputMessage(id="m1", type="message", role="assistant", status="completed", content=[text])
                return ModelResponse(output=[msg], usage=Usage(), response_id=None)

            def stream_response(self, *a, **kw):
                raise NotImplementedError

        _, out = self.run_example("openai_agents.py", mock.patch.object(MultiProvider, "get_model", lambda self, name: ScriptedModel()))
        self.assertEqual(out, "Billing deploys on Fridays.\n")
        [instructions] = seen
        self.assertTrue(instructions.startswith("You help customers.\n<oort-memory>\n"), instructions)
        self.assertIn("We deploy the billing service on Fridays.", instructions)
        with self.d.oort(agent="support-bot") as o:
            texts = [m.text for m in o.recent(limit=10).memories]
        self.assertIn("When do we deploy billing?", texts)  # the turn, observed after answering


class CrewAI(FrameworkCase):
    framework = "crewai"
    modules = ("crewai",)

    def test_recalls_into_the_task_then_observes(self) -> None:
        from crewai.llms.base_llm import BaseLLM

        with self.d.oort() as o:
            o.remember("We deploy the billing service on Fridays {not a template}.")
        seen = []

        class ScriptedLLM(BaseLLM):
            """Answers once, and keeps the messages it was sent."""

            def call(self, messages, *a, **kw):
                seen.append(messages if isinstance(messages, str) else "\n".join(str(m.get("content")) for m in messages))
                return "Thought: I know this.\nFinal Answer: Billing deploys on Fridays."

        llm = mock.patch("crewai.LLM", lambda model, **kw: ScriptedLLM(model=model))
        _, out = self.run_example("crewai_agent.py", llm)
        self.assertEqual(out.strip().splitlines()[-1], "Billing deploys on Fridays.")
        self.assertTrue(seen)
        self.assertIn("Answer this question: When do we deploy billing?", seen[0])
        self.assertIn("<oort-memory>\n", seen[0])
        self.assertIn("We deploy the billing service on Fridays {not a template}.", seen[0])
        with self.d.oort(agent="support-crew") as o:
            texts = [m.text for m in o.recent(limit=10).memories]
        self.assertIn("When do we deploy billing?", texts)


if __name__ == "__main__":
    unittest.main()
