import { createMemoryStore } from './memory-store.js';
import { storeConformance } from './store-conformance.js';

storeConformance('memory', async () => createMemoryStore());
