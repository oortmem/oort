# @oortmem/core

The Oort engine: memory types, scopes, hot, warm and cold tiers, hybrid recall with freshness, and the adapter interfaces the other packages implement.

```sh
npm install @oortmem/core
```

```ts
import { createMemoryStore } from '@oortmem/core';
```

Most people use it through the `oortmem` CLI, or from code through `oortmem`'s SDK (`import { createOort } from 'oortmem'`), which has a semver promise. These building blocks carry no stability promise: use them directly to build your own store or adapters. `@oortmem/core/store-conformance` holds the test suite any store must pass (it needs `vitest`).

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. See the [main README](https://github.com/oortmem/oort#readme) for how the pieces fit. Apache-2.0.
