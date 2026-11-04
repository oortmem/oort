# @oortmem/decide-jev

Decides what happens to each new fact: add, update, supersede or skip. It uses TypeSafe Jev, which returns typed answers with probabilities.

```sh
npm install @oortmem/decide-jev
```

```ts
import { jevDecider } from '@oortmem/decide-jev';

const decide = jevDecider({ apiKey: process.env.TYPESAFE_API_KEY });
```

Part of [Oort](https://github.com/oortmem/oort), open-source memory for AI agents. See the [main README](https://github.com/oortmem/oort#readme) for how the pieces fit. Apache-2.0.
