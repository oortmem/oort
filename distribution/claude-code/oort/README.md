# Oort for Claude Code

Memory across sessions: Oort recalls relevant facts before each prompt, saves what matters after
each turn, and adds the `oort` memory tools and the `oort-memory` skill. Memories stay on your
machine.

Needs the `oort` command (`npm install -g oortmem`, then `oort setup` for keys or Oort Pro).

```sh
claude plugin marketplace add oortmem/oort
claude plugin install oort@oortmem
```

If you ran `oort install claude-code` before, run `oort uninstall claude-code` first, so the
hooks are not added twice. More at [oortcloud.dev/docs](https://oortcloud.dev/docs/quickstart).
