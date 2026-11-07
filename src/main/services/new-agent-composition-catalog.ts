import { renameSync } from 'node:fs';
import type { BaseAdoption, CompositionInput } from '../../shared/asset-catalog-types';
import { assertCreationCompositionReservation, type CreationCompositionReservation } from './agent-config';
import { assetCatalogDir, createAssetCatalogStore } from './asset-catalog/store';

/** Immutable reviewed input held in main; never a callback supplied through IPC. */
export interface ReviewedCreationComposition {
  agentId: string;
  projectId: string;
  composition: CompositionInput;
  adoption: BaseAdoption;
  previewFingerprint: string;
  sourceRevisions: Record<string, number>;
}

/**
 * Build the required save callback from the already-reviewed main draft. The
 * caller must additionally bind the project registry and draft token before
 * issuing this callback. No asset deletion, adoption or readiness occurs here.
 */
export function creationCompositionCommit(reviewed: ReviewedCreationComposition, assertProjectCurrent: () => void) {
  const snapshot = structuredClone(reviewed);
  return async (config: { id: string }, reservation: CreationCompositionReservation): Promise<void> => {
    const guard = () => {
      if (config.id !== snapshot.agentId) throw new Error('Creation composition target changed.');
      assertCreationCompositionReservation(reservation, snapshot.agentId);
      assertProjectCurrent();
    };
    guard();
    const store = createAssetCatalogStore({
      dir: assetCatalogDir(),
      // The same guard is checked on every rename attempt. There is no await
      // between the ownership/project check and the synchronous index rename.
      rename: async (from, to) => { guard(); renameSync(from, to); },
    });
    await store.saveComposition({
      agentId: snapshot.agentId, projectId: snapshot.projectId, expectedRevision: 0,
      composition: snapshot.composition, adoption: snapshot.adoption,
      previewFingerprint: snapshot.previewFingerprint,
      expectedAssetRevisions: snapshot.sourceRevisions,
    });
    // Do not re-check cancellation here: the owner must journal the committed
    // save before its final cancellation check. The rename guard is authoritative.
  };
}
