import { createMemoryStore, memoryStoreProbe } from './memory-store.js';
import { linksConformance, spatialConformance, storeConformance } from './store-conformance.js';

storeConformance('memory', async () => createMemoryStore());
spatialConformance('memory', async () => createMemoryStore());
linksConformance('memory', async () => createMemoryStore(), memoryStoreProbe);
