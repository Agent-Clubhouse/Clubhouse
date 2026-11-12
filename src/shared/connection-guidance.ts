/** Original guidance retained by one source of a directed connection. */
export interface ConnectionGuidanceSource {
  sourceId: string;
  storeId?: string;
  label?: string;
  instructions: Record<string, string>;
}

export interface ConnectionGuidanceSnapshot {
  agentId: string;
  targetId: string;
  instructions: Record<string, string>;
  hasOverride: boolean;
  sources: ConnectionGuidanceSource[];
  unreadable: string[];
  conflictingSources: boolean;
  needsSourceConfirmation: boolean;
  readOnly: boolean;
  readOnlyReason?: string;
  revision: string;
  /** The disk save committed, but changed live ownership prevented publication. */
  notice?: string;
}

export interface SaveConnectionGuidance {
  instructions: Record<string, string>;
  revision: string;
  replaceAcrossSources?: boolean;
}
