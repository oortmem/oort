import { createMemoryStore } from './memory-store.js';
import { spatialConformance, storeConformance } from './store-conformance.js';

storeConformance('memory', async () => createMemoryStore());
spatialConformance('memory', async () => createMemoryStore());
