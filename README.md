# Oort

Oort is an open-source memory engine for AI agents. It tiers memory into hot, warm, and cold storage so agents keep recent context close and older knowledge cheap to retain. It is local-first, with a hosted cloud to follow later.

To get started, run `pnpm install && pnpm verify`. That installs dependencies and runs formatting, lint, build, typecheck, and tests across every package.

To use the `oort` CLI, install it with `npm i -g oortmem` and run `oort setup`, or start with `npx oortmem setup`, which offers the global install first. From a clone of this repo: `pnpm build && cd packages/cli && pnpm add -g .`. It connects Claude Code (hooks) and Claude Desktop, Codex, Cursor, Gemini CLI or VS Code (the local MCP server). Every command is in [docs/cli.md](docs/cli.md).

A project's `oort.config.json` shapes recall in that project, but not the write path: queued turns are observed by a background drain that runs in `~/.oort` and reads only `~/.oort/config.json`. The store's `embed.dimension` likewise always comes from the home config; a different project value is ignored with a warning.

Memories are scoped to a project: by default its id is derived from the main repository root, so a git worktree shares memories with its main checkout. A `project.id` in `oort.config.json` is ignored until you trust it, because that file comes with the repository and a cloned repo could use it to name another project's memories. Run `oort project link` in the repository to bind it to the configured id (or `oort project link --id <id>`), and `oort project unlink` to go back. `link` refuses a configured id that another repository is already linked to, unless you pass it with `--id`; the binding lives in `~/.oort/project-links.json` and the scope becomes `cfg:<id>`.
