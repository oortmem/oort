# @oortmem/claude-code

Oort for Claude Code: the hooks that recall memories at the start of a prompt and save new facts after a turn, plus import of past transcripts.

```sh
npm install -g oortmem
oort setup
```

You normally get this through the `oortmem` CLI, which installs the hooks for you. The package exports `importTranscripts` and the hook logger for your own tooling.

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. See the [main README](https://github.com/oortmem/oort#readme) for how the pieces fit. Apache-2.0.
