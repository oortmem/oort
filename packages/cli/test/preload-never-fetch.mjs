// Loaded into the built bin with NODE_OPTIONS=--import=<this file> by
// cli.hook-exits-promptly-with-slow-adapters: every fetch hangs forever, and a
// ref'd interval keeps the event loop alive, so the hook only ends promptly if
// it exits on its own.
globalThis.fetch = () => new Promise(() => {});
setInterval(() => {}, 60_000);
