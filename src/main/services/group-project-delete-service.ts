import { groupProjectHost } from './group-project-host';
import { createGroupProjectDeletionService } from './group-project-deletion';
import { readGroupProjectDeletionInventory } from './group-project-delete-inventory';
import { readGroupProjectCanvasInventory, removeGroupProjectFromCanvasInventory } from './group-project-canvas-inventory';
import { withCanvasWriteBarrier } from './canvas-write-barrier';
import { writeKeyWithinCanvasBarrier } from './plugin-storage';

// The host lane supplies these journal operations in its next update.
const journal = groupProjectHost as typeof groupProjectHost & {
  beginDelete(id: string, options: { expectedSeq: number; withinExclusive: true }): Promise<unknown>;
  finishDelete(id: string, options: { withinExclusive: true }): Promise<unknown>;
  listPendingDeletes(): Promise<Array<{ groupProjectId: string }>>;
  exclusivePending<T>(id: string, callback: () => Promise<T>): Promise<T>;
};

/** Build the local cascade; release is supplied by the durable membership source. */
export function createLocalGroupProjectDeleteService(releaseBindings: (id: string) => void) {
  const cleanup = async (id: string) => {
    const canvas = await readGroupProjectCanvasInventory(id);
    await removeGroupProjectFromCanvasInventory(canvas, id, writeKeyWithinCanvasBarrier);
    releaseBindings(id);
    await journal.finishDelete(id, { withinExclusive: true });
  };
  const service = createGroupProjectDeletionService({
    inventory: readGroupProjectDeletionInventory,
    cascade: async (id, expected) => withCanvasWriteBarrier(() => groupProjectHost.exclusive(id, async ({ seq }) => {
      if (String(seq) !== expected.revisions[0]) throw new Error('The group project changed. Refresh the impact check before deleting.');
      const current = await readGroupProjectDeletionInventory(id);
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The impact changed. Refresh the impact check before deleting.');
      const canvas = await readGroupProjectCanvasInventory(id);
      if (canvas.revision !== expected.revisions[1]) throw new Error('The canvases changed. Refresh the impact check before deleting.');
      await journal.beginDelete(id, { expectedSeq: seq, withinExclusive: true });
      await cleanup(id);
    })),
  });
  return {
    ...service,
    async recoverPending() {
      const errors: unknown[] = [];
      for (const tombstone of await journal.listPendingDeletes()) {
        try {
          await withCanvasWriteBarrier(() => journal.exclusivePending(tombstone.groupProjectId, () => cleanup(tombstone.groupProjectId)));
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new Error(`${errors.length} group project deletion(s) could not be completed.`);
    },
  };
}
