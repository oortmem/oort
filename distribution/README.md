# Installing Oort in your agent

Every option below runs Oort locally: your memories stay on your machine. Install the command
line first, except for Claude Desktop's bundle, which carries its own copy:

```sh
npm install -g oortmem   # gives you `oort`
oort setup               # keys or Oort Pro, then connects the agents it finds
```

`oort setup` and `oort connect <host>` write each host's config for you. The files here are for
installing through each host's own plugin or extension system instead.

| Host           | What you get                                                     | How                                         |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| Claude Code    | Memory tools, the skill, and automatic recall and saving (hooks) | Plugin, below                               |
| Claude Desktop | Memory tools, with no Node.js or command line needed             | `.mcpb` bundle, below                       |
| Codex          | Memory tools, the skill, and automatic recall before each prompt | Plugin, below                               |
| Cursor         | Memory tools in the open workspace                               | `oort connect cursor`, or the snippet below |
| Gemini CLI     | Memory tools                                                     | `oort connect gemini`, or the snippet below |

Use one way per host. The Claude Code plugin and `oort install claude-code` both add the same
hooks; with both, every prompt would recall twice. Run `oort uninstall claude-code` before
installing the plugin.

## Claude Code plugin

```sh
claude plugin marketplace add oortmem/oort
claude plugin install oort@oortmem
```

It adds the `oort` MCP server (`oort mcp`), the `oort-memory` skill, and three hooks:
`UserPromptSubmit` (recall), `Stop` (save the turn) and `SessionStart` (pinned and hot
memories). Source: [`claude-code/oort`](claude-code/oort).

## Claude Desktop bundle

Download `oort-darwin-arm64.mcpb` (Apple silicon) or `oort-darwin-x64.mcpb` (Intel) from the
GitHub release, then open it, or drag it into Claude Desktop under Settings → Extensions. Claude
Desktop runs it with the Node.js it ships with. In its settings you can set the memory folder
(default `~/.oort`, shared with the command line) and either an Oort Pro key or your own Voyage,
TypeSafe and Anthropic keys. Claude Desktop keeps those keys in the system keychain.

Build it yourself: `pnpm build && pnpm bundle:mcpb` writes `dist/oort-<platform>-<arch>.mcpb`.
It contains native modules (SQLite), so build it on the platform it is for. Source:
[`claude-desktop`](claude-desktop).

## Codex plugin

```sh
codex plugin marketplace add oortmem/oort
```

then install `oort` from that marketplace in Codex. It adds the `oort` MCP server, the skill,
and the `UserPromptSubmit` and `SessionStart` hooks. Codex's `Stop` hook gets a Codex transcript,
which Oort does not read yet, so saving happens through the `remember` tool for now. Source:
[`codex/oort`](codex/oort).

Without the plugin, `oort connect codex` adds this to `~/.codex/config.toml`:

```toml
[mcp_servers.oort]
command = "oort"
args = ["mcp"]
```

## Cursor

`oort connect cursor`, or add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "oort": {
      "type": "stdio",
      "command": "oort",
      "args": ["mcp", "--project", "${workspaceFolder}"]
    }
  }
}
```

`--project ${workspaceFolder}` keeps memories per workspace.

## Gemini CLI

`oort connect gemini`, or add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "oort": { "command": "oort", "args": ["mcp"] }
  }
}
```

Memories follow the directory Gemini CLI starts in, plus global ones.

## Formats

Checked against each host's primary docs on 2026-11-04: the MCPB manifest spec 0.3
(`modelcontextprotocol/mcpb`), Claude Code's plugin and marketplace layout
(`anthropics/claude-code`), and Codex's plugin manifest, `.mcp.json`, hook events and
`.agents/plugins/marketplace.json` (`openai/codex`). Cursor and Gemini CLI entries are the ones
`oort connect` writes (`packages/cli/src/connectors.ts`).
