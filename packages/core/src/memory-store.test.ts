import { createMemoryStore, memoryStoreProbe } from './memory-store.js';
import {
  linksConformance,
  occurrenceConformance,
  spatialConformance,
  storeConformance,
} from './store-conformance.js';

storeConformance('memory', async () => createMemoryStore());
spatialConformance('memory', async () => createMemoryStore());
linksConformance('memory', async () => createMemoryStore(), memoryStoreProbe);
occurrenceConformance('memory', async () => createMemoryStore());
