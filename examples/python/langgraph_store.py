import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Iterable, Mapping

from langchain_anthropic import ChatAnthropic
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.runtime import Runtime
from langgraph.store.base import BaseStore, GetOp, Item, Op, PutOp, Result, SearchItem, SearchOp

from oortmem import Oort, OortNotFoundError, format_for_prompt


class OortStore(BaseStore):
    """A LangGraph ``BaseStore`` over Oort: ``search`` with a query recalls, ``put`` remembers
    ``{"text": ...}``, a ``None`` put (``delete``) forgets, and ``get`` explains. Oort assigns the
    ids, so a put's key is not kept: ``get`` and ``delete`` take Oort ids. ``scope_of`` (your code)
    maps a namespace to ``scoped()`` options. Oort ranks by relevance: a search without a query
    returns nothing, ``filter`` and ``offset`` are refused, and ``index`` is ignored."""

    def __init__(self, oort: Oort, scope_of: Callable[[tuple], Mapping[str, Any]]) -> None:
        self.oort = oort
        self.scope_of = scope_of

    def handle(self, namespace: tuple) -> Oort:
        return self.oort.scoped(**self.scope_of(namespace), judge_role="agent")

    def batch(self, ops: Iterable[Op]) -> list[Result]:
        return [self._run(op) for op in ops]  # in order: a put, then a get, sees the put

    async def abatch(self, ops: Iterable[Op]) -> list[Result]:
        return await asyncio.to_thread(self.batch, list(ops))  # the client is blocking I/O

    def _run(self, op: Op) -> Result:
        if isinstance(op, SearchOp):
            if op.filter or op.offset:
                raise NotImplementedError("OortStore searches by relevance only: no filter or offset")
            if op.query is None:
                return []  # Oort lists by relevance only
            r = self.handle(op.namespace_prefix).recall(op.query, limit=op.limit)
            return [SearchItem(op.namespace_prefix, m.id, {"text": m.text}, *_dates(m), m.score) for m in r.memories]
        if isinstance(op, PutOp):
            mem = self.handle(op.namespace)
            text = None if op.value is None else op.value.get("text")
            if op.value is None:
                mem.forget(op.key)
            elif isinstance(text, str):
                mem.remember(text)
            else:
                raise TypeError("OortStore stores values of the form {'text': str}")
            return None
        if isinstance(op, GetOp):
            try:
                m = self.handle(op.namespace).explain(op.key).memory
            except OortNotFoundError:
                return None
            created, updated = _dates(m)
            return Item(value={"text": m.text}, key=m.id, namespace=op.namespace, created_at=created, updated_at=updated)
        return []  # list_namespaces: users are your app's, not Oort's


def _dates(m: Any) -> tuple[datetime, datetime]:
    iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))  # noqa: E731 (3.10 needs it)
    return iso(m.recorded_at), iso(m.updated_at)


@dataclass
class Context:
    user_id: str


oort = Oort(mode="local", org="acme", project=None, project_config=False)
# The first namespace part is the end user. A missing one is refused (`user-missing`), never
# falling back to the tenant's own memory.
store = OortStore(oort, lambda namespace: {"user": namespace[0] if namespace else ""})
model = ChatAnthropic(model="claude-haiku-5-5")


def answer(state: MessagesState, runtime: Runtime[Context]) -> dict:
    question = state["messages"][-1].text
    mem = store.handle((runtime.context.user_id,))
    memory = format_for_prompt(mem.recall(question))
    reply = model.invoke([{"role": "system", "content": f"You help customers.\n{memory}"}, *state["messages"]])
    mem.observe(user=question, assistant=reply.text)
    return {"messages": [reply]}


graph = StateGraph(MessagesState, context_schema=Context).add_node(answer).add_edge(START, "answer").compile(store=store)

store.put(("user-ada",), "order", {"text": "My order number is 1042."})
out = graph.invoke(
    {"messages": [{"role": "user", "content": "What is my order number?"}]},
    context=Context(user_id="user-ada"),
)
print(out["messages"][-1].text)
oort.close()
