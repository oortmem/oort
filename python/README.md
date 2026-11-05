# oortmem

Open-source memory for AI agents. Old facts are closed out, not overwritten, and every recall can explain why it was picked.

This package installs the `oort` command for Python users. Oort itself is written in TypeScript and published on npm, so it needs **Node.js 22.15 or newer**. The launcher runs an `oort` you already have, or the matching npm release through `npx`. Arguments and exit codes pass straight through.

```sh
pipx install oortmem
oort setup
oort recall "where does the user live"
```

Without Node, `oort` tells you how to install it. You can also skip Python entirely with `npm install -g oortmem`.

- Docs: https://oortcloud.dev/docs
- Source: https://github.com/oortmem/oort
- License: Apache 2.0
