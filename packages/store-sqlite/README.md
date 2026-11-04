# @oortmem/store-sqlite

The local Oort store: SQLite with FTS5 for keywords, sqlite-vec for vectors, and zstd blobs for the cold tier.

```sh
npm install @oortmem/store-sqlite
```

```ts
import { openSqliteStore } from '@oortmem/store-sqlite';

const store = await openSqliteStore({ path: './oort.db', coldDir: './cold', dimension: 512 });
```

Directories it creates are owner-only.

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. See the [main README](https://github.com/oortmem/oort#readme) for how the pieces fit. Apache-2.0.
