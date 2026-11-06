# oortmem

Open-source memory for AI agents. Old facts are closed out, not overwritten, and every recall can explain why it was picked.

This package is the native Python client for Oort (`from oortmem import Oort`, or `AsyncOort`), and it also installs the `oort` command.

```python
from oortmem import Oort, format_for_prompt

with Oort() as oort:
    r = oort.recall("how do we deploy?")
    print(format_for_prompt(r))
```

Local mode talks to `oort serve` on this machine (needs Node.js 22.15 or newer and the `oort` CLI); `mode="cloud"` calls Oort Cloud over HTTPS and needs no Node. Python 3.10 or newer, no dependencies. Guide: https://github.com/oortmem/oort/blob/main/docs/python.md

The rest of this page is the `oort` command launcher. Oort itself is written in TypeScript and published on npm, so it needs **Node.js 22.15 or newer**. The launcher runs an `oort` you already have, or the matching npm release through `npx`. Arguments and exit codes pass straight through.

```sh
pipx install oortmem
oort setup
oort recall "where does the user live"
```

Without Node, `oort` tells you how to install it. You can also skip Python entirely with `npm install -g oortmem`.

- Docs: https://oortcloud.dev/docs
- Source: https://github.com/oortmem/oort
- License: Apache 2.0
