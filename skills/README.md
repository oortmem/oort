# Skills for building with Oort

Agent Skills that teach a coding agent (Claude Code, Codex, Cursor, Gemini CLI and others) to
build Oort into your own apps. Each folder is a standalone skill in the open
[Agent Skills](https://agentskills.io/specification) format: a `SKILL.md` plus `references/`
the agent reads only when it needs them.

| Skill                  | For                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`oort-sdk`](oort-sdk) | Integrating `oortmem` 0.6.3: when to use hooks, MCP, the SDK or the CLI; `createOort` modes and options; recall, observe and `formatForPrompt` in an agent loop; multi-user apps; judgments; errors; the Vercel AI SDK, LangGraph.js and OpenAI Agents JS; serverless and self-hosting; costs; Python through the CLI; security |

This is not the skill for using memory as an assistant: that one, `oort-memory`, ships with the
`oort` plugin and the `@oortmem/mcp` package.

## Install

**Claude Code**, as a plugin (update it later with `claude plugin update oort-dev@oortmem`, or
turn on auto-update for the marketplace in `/plugin`):

```sh
claude plugin marketplace add oortmem/oort
claude plugin install oort-dev@oortmem
```

or inside a session, `/plugin marketplace add oortmem/oort`, then `/plugin install oort-dev@oortmem`.
Claude loads the skill when you ask it to add memory to an app; `/oort-dev:oort-sdk` runs it by
name. The `oort-dev` plugin adds no hooks and no MCP server, so it works alone or next to the
`oort` plugin.

**Codex**, as a plugin:

```sh
codex plugin marketplace add oortmem/oort
codex plugin add oort-dev@oortmem
```

or open `/plugins` in Codex and install `oort-dev` from the Oort marketplace. Mention it with
`$oort-sdk`, or let Codex pick it from the task.

**Any agent that reads SKILL.md**, by copying the folder into its skills directory:

```sh
git clone --depth 1 https://github.com/oortmem/oort /tmp/oort
cp -R /tmp/oort/skills/oort-sdk ~/.claude/skills/     # Claude Code, every project
cp -R /tmp/oort/skills/oort-sdk .claude/skills/       # Claude Code, this repository
cp -R /tmp/oort/skills/oort-sdk ~/.agents/skills/     # Codex, every project
cp -R /tmp/oort/skills/oort-sdk .agents/skills/       # Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode and others, this repository
```

or with the [`skills`](https://github.com/vercel-labs/skills) installer, which knows each agent's
directory: `npx skills add oortmem/oort --skill oort-sdk` (add `-a <agent>` to pick one, `-g`
for every project). A copy does not update itself: copy it again after upgrading `oortmem`. Its
`metadata.oortmem-version` says which release it describes.

## Keeping it true

`pnpm verify` fails when the skill drifts from what `oortmem` ships:
[examples/test/skill.test.ts](../examples/test/skill.test.ts) checks the format, that every
TypeScript block is a tested file in [examples/src](../examples/src) byte for byte, that the
Python wrapper runs against the built CLI, that every SDK name is in the built declarations and
every `oort` command and flag is in [docs/cli.md](../docs/cli.md). The copies under
`distribution/*/oort-dev/` are generated: edit `skills/`, then run `pnpm skills:sync`.
