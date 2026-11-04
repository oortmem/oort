---
name: oort-memory
description: Use Oort, the user's long-term memory, well. Recall before answering about earlier work, decisions, preferences or project details; remember durable facts the user states or confirms; never store secrets.
---

# Oort memory

Oort keeps facts the user chose to keep across sessions. It is connected as the `oort` MCP server
with seven tools: `recall`, `remember`, `forget`, `pin`, `explain`, `list_recent` and `whoami`.

## When to recall

- The user refers to earlier work: "like last time", "the approach we picked", "my usual setup".
- Their past context would change the answer: a stack, a convention, a preference, a decision.
- Skip it for self-contained questions. A recall that finds nothing relevant returns
  `abstained: true`; answer without memory then, and do not mention Oort.
- Questions about time: `as_of` for what was true then ("what did we use in March"),
  `mode: "history"` for how a fact changed, `known_at` for what was believed then. Oort also
  reads these from the query; the result's `mode` says which it used.
- A recalled fact with `stale: true` is volatile and has not been confirmed lately. Check it with
  the user before relying on it, and `remember` the answer.

## When to remember

- Only durable facts the user stated or confirmed: decisions and why, preferences, project facts,
  how something is done here.
- One standalone sentence per fact, true without the conversation around it. Name things fully:
  "The billing service runs on port 8443", not "it uses that port".
- Batch the facts of one decision into a single `remember` call (at most five).
- Never secrets, keys, passwords or personal data the user did not ask you to keep. Oort scrubs
  secrets, but do not send them.
- Do not remember your own suggestions unless the user accepted them.

## Changing and removing

- A newer fact supersedes an older one on its own; you do not need to forget the old one first.
- `forget` deletes permanently. Use it when the user asks, and confirm which memory with
  `list_recent` or `explain` first.
- `pin` keeps a memory always available. Use it only when the user asks.

## Telling the user

Say briefly what you saved ("Saved: billing runs on port 8443."). When a recalled fact shaped
the answer, you can say so; `explain` shows why it was stored and what it replaced.
