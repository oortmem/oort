# @oortmem/mcp

Oort's MCP server, defined once: the seven memory tools (`recall`, `remember`, `forget`, `pin`,
`explain`, `list_recent`, `whoami`) with their input schemas and read, write and destructive
annotations, the server instructions, and a skill that tells an agent when to recall and when to
remember. It serves any memory backend: the local store behind `oort mcp` today, Oort Cloud
later.

```sh
npm install @oortmem/mcp
```

```ts
import { createMcpServer, type MemoryBackend } from '@oortmem/mcp';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const backend: MemoryBackend = {/* recall, remember, forget, pin, explain, listRecent, whoami */};
serveStdio(() => createMcpServer({ backend }));
```

Every method acts inside the scope the backend was built for; no tool argument can widen it.
Throw `MemoryToolError` for a refusal the user should read. Text in every result is scrubbed for
secrets once more before it reaches the host.

Hosts that render [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) also get two
in-chat widgets: a recall card (the memories, their tier, dates and why each was picked) and a
memory card (`explain`'s history and decisions, or what `remember` saved). They are `ui://`
resources linked from the tool's `_meta.ui`, built from the tool's own result, with no network
access and no remote scripts. Tool results are the same text either way, and a host that
declares no MCP Apps support is not offered them. Pass `widgets: false` to turn them off.

What a connection may reach comes from trusted configuration, never from the model: pass
`spaces: { include, visibility, share }` (default `PLANET_ONLY`). `recall.include` then lists only
those levels, `remember.visibility` only `private` and the Constellations named, and the `share`
tool is offered only when `share` names a Constellation and the backend implements `share()`.
Arguments a model invents (a `scope`, `project` or `agent`) are dropped before the backend.

Also exported: `TOOLS`, `TOOL_NAMES`, `INSTRUCTIONS`, `inputSchemas` (zod), `inputSchemasFor()`,
`toolJsonSchemas()`
(JSON Schema), `REMEMBER_MAX_FACTS` and `FACT_MAX_CHARS`. The skill is at
`@oortmem/mcp/skill/SKILL.md`.

Most people want the `oortmem` CLI instead: `oort mcp` runs this server over your local memory.

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. Apache-2.0.
