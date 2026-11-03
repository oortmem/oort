# Oort

Oort is an open-source memory engine for AI agents. It tiers memory into hot, warm, and cold storage so agents keep recent context close and older knowledge cheap to retain. It is local-first, with a hosted cloud to follow later.

To get started, run `pnpm install && pnpm verify`. That installs dependencies and runs formatting, lint, build, typecheck, and tests across every package.

To use the `oort` CLI with Claude Code, install it from the repo with `pnpm build && cd packages/cli && pnpm add -g .`, then run `oort init` and `oort install claude-code`.
