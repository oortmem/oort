# @oortmem/writer

Turns conversation turns into short, self-contained facts, using Claude through the Vercel AI SDK.

```sh
npm install @oortmem/writer
```

```ts
import { anthropicWriter } from '@oortmem/writer';

const writer = anthropicWriter({ apiKey: process.env.ANTHROPIC_API_KEY });
```

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. See the [main README](https://github.com/oortmem/oort#readme) for how the pieces fit. Apache-2.0.
