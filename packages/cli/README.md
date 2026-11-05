# oortmem

The `oort` command line. It gives your coding agent a memory that stays correct as facts change.

```sh
npm install -g oortmem
oort setup
```

`oort setup` finds your agents (Claude Code, Claude Desktop, Codex, Cursor, VS Code, Gemini CLI), connects them and checks that recall works.

Other commands you will use:

- `oort doctor` checks keys, hooks, connectors and the store.
- `oort mcp` runs the local MCP server for any MCP client.
- `oort connect <host>` and `oort disconnect <host>` add or remove one agent (`oort install <host>` does the same).
- `oort serve --detach` starts a local daemon that makes the Claude Code hooks faster; they work without it.
- `oort login` uses Oort Pro, so you need no vendor keys.
- `oort keys set <provider>` stores your own Voyage, TypeSafe or Anthropic key.

Your memories stay on your machine, in `~/.oort`. Needs Node.js 22.15 or later.

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. See the [main README](https://github.com/oortmem/oort#readme) for how the pieces fit. Apache-2.0.
