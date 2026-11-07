/** Main-only lifecycle primitives. Not yet connected to creation or renderer IPC. */
export interface CreationCompositionMarker {
  readonly reservationId: string;
  readonly agentId: string;
  /** Revision observed before the first save; new reservations require zero. */
  readonly beforeRevision: 0;
  readonly expectedRevision: 1;
  readonly phase: 'prepared' | 'committed';
}

export type CreationCompositionRecovery =
  | { kind: 'absent'; mayRemoveCreation: true }
  | { kind: 'retain'; mayRemoveCreation: false; reason: 'saved' | 'changed' | 'missing-after-commit' | 'unknown' };

/**
 * Recovery never deletes catalog state. Even a matching revision remains saved
 * desired state until the owning creation explicitly reconciles it. An unknown
 * read cannot be substituted for an absent composition.
 */
export function classifyCreationComposition(
  marker: CreationCompositionMarker,
  observation: { known: false } | { known: true; revision: number | null },
): CreationCompositionRecovery {
  if (!observation.known) return { kind: 'retain', mayRemoveCreation: false, reason: 'unknown' };
  if (observation.revision === null) {
    return marker.phase === 'prepared'
      ? { kind: 'absent', mayRemoveCreation: true }
      : { kind: 'retain', mayRemoveCreation: false, reason: 'missing-after-commit' };
  }
  return {
    kind: 'retain', mayRemoveCreation: false,
    reason: observation.revision === marker.expectedRevision ? 'saved' : 'changed',
  };
}

export interface CreationCompositionPhase {
  /** Persist ownership before catalog mutation. */
  prepare(): Promise<void>;
  /** Must validate live reservation at the actual catalog commit boundary. */
  commit(): Promise<void>;
  /** Persist committed marker before readiness can be considered. */
  recordCommitted(): Promise<void>;
  /** Check cancellation and the live main-owned reservation; throws on refusal. */
  assertCurrent(): void;
}

/** Required phase: unlike legacy persona injection, no error is swallowed. */
export async function commitCreationComposition(phase: CreationCompositionPhase): Promise<void> {
  phase.assertCurrent();
  await phase.prepare();
  phase.assertCurrent();
  await phase.commit();
  // Persist the fact of commit even when cancellation arrived during commit.
  // Recovery needs it; cancellation is checked again before returning success.
  await phase.recordCommitted();
  phase.assertCurrent();
}
