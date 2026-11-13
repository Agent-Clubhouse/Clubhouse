import { groupProjectHost } from './group-project-host';
import { createGroupProjectDeletionService } from './group-project-deletion';
import { readGroupProjectDeletionInventory } from './group-project-delete-inventory';
import { readGroupProjectCanvasInventory, removeGroupProjectFromCanvasInventory } from './group-project-canvas-inventory';
import { withCanvasWriteBarrier } from './canvas-write-barrier';
import { writeKeyWithinCanvasBarrier } from './plugin-storage';
import { forgetPollingRuns } from './group-project-polling-runs';

/** Build the local cascade; release is supplied by the durable membership source. */
export function createLocalGroupProjectDeleteService(releaseBindings: (id: string) => void) {
  return createGroupProjectDeletionService({
    inventory: readGroupProjectDeletionInventory,
    cascade: async (id, expected) => withCanvasWriteBarrier(() => groupProjectHost.exclusive(id, async ({ seq }) => {
      if (String(seq) !== expected.revisions[0]) throw new Error('The group project changed. Refresh the impact check before deleting.');
      const current = await readGroupProjectDeletionInventory(id);
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The impact changed. Refresh the impact check before deleting.');
      const canvas = await readGroupProjectCanvasInventory(id);
      if (canvas.revision !== expected.revisions[1]) throw new Error('The canvases changed. Refresh the impact check before deleting.');
      await removeGroupProjectFromCanvasInventory(canvas, id, writeKeyWithinCanvasBarrier);
      const result = await groupProjectHost.delete(id, { expectedSeq: seq, withinExclusive: true });
      if (!result.deleted) throw new Error('This group project is no longer available on this host.');
      releaseBindings(id);
      forgetPollingRuns(id);
    })),
  });
}
