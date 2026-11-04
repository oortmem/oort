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

Also exported: `TOOLS`, `TOOL_NAMES`, `INSTRUCTIONS`, `inputSchemas` (zod), `toolJsonSchemas()`
(JSON Schema), `REMEMBER_MAX_FACTS` and `FACT_MAX_CHARS`. The skill is at
`@oortmem/mcp/skill/SKILL.md`.

Most people want the `oortmem` CLI instead: `oort mcp` runs this server over your local memory.

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. Apache-2.0.
