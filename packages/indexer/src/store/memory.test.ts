import { describeAnnouncementStoreSpec } from './announcements.spec-shared.js';
import { MemoryAnnouncementStore } from './memory.js';

// Backend-agnostic AnnouncementStore contract against the in-process memory
// backend — the identical spec the Postgres backend runs.
describeAnnouncementStoreSpec('AnnouncementStore (memory)', async () => {
  const store = new MemoryAnnouncementStore();
  await store.init();
  return { store, cleanup: async () => {} };
});
