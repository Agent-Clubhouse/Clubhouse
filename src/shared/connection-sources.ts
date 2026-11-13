/**
 * Where a connection between two agents comes from (#2744). A pair (one
 * direction) can be held by several sources at once; removing one leaves the
 * others, and the connection stays while any source still lists it.
 */
export type ConnectionSourceKind =
  /** A wire drawn on a canvas (or a zone wire there). Removed on the canvas. */
  | 'canvas'
  /** A helper and its orchestrator: always connected while the helper exists. */
  | 'helper'
  /** "Connect to Dispatcher" on the agent: the Dispatcher's automatic wire. */
  | 'dispatcher_auto'
  /** A link an agent made with connect_agents (or a legacy group-project membership). */
  | 'tool_link'
  /** A link the Dispatcher made between two orchestrators. */
  | 'dispatcher_link'
  /** A link the user made on the Connections card (Make two-way, #2972). */
  | 'user_link'
  /** A source this build doesn't know. */
  | 'dispatcher_federation'
  | 'other';

export interface ConnectionSource {
  kind: ConnectionSourceKind;
  /** The persisted source's id, for logs. */
  sourceId: string;
  /** A Dispatcher link that isn't active: why. */
  suspended?: string;
  /** Agent sources on the network, including their originating computer. */
  makers?: Array<{ agentId: string; machineId: string; name?: string }>;
}

/** One direction of a connection and what holds it. */
export interface ConnectionPairSources {
  agentId: string;
  targetId: string;
  /** Live now (a binding exists). A suspended Dispatcher link isn't. */
  bound: boolean;
  sources: ConnectionSource[];
  /**
   * Bound, but no source lists it: from a source that couldn't be read this
   * time, or not saved anywhere (it goes at the next restart). Shown as
   * unresolved, never guessed.
   */
  unresolved?: boolean;
  /** Proven saved-only automatic direction, for inspection. Never a live binding or permission. */
  inspection?: {
    targetKind: 'agent';
    agentName: string;
    targetName: string;
  };
}

export interface AgentConnectionSources {
  pairs: ConnectionPairSources[];
  /** Sources that couldn't be read: their part may be missing. */
  unreadable: string[];
}

/** Which sources can be removed from the Connections card, and how. */
export function removalRoute(kind: ConnectionSourceKind): 'here' | 'canvas' | 'helpers' | 'none' {
  switch (kind) {
    case 'tool_link':
    case 'dispatcher_link':
    case 'dispatcher_auto':
    case 'user_link':
      return 'here';
    case 'canvas':
      return 'canvas';
    case 'helper':
      return 'helpers';
    default:
      return 'none';
  }
}

export const CONNECTION_SOURCE_LABELS: Readonly<Record<ConnectionSourceKind, string>> = {
  canvas: 'Canvas wire',
  helper: 'Helper',
  dispatcher_auto: 'Connect to Dispatcher',
  tool_link: 'Made by an agent',
  dispatcher_link: 'Made by the Dispatcher',
  user_link: 'Made by you',
  dispatcher_federation: 'Annex Network controllers',
  other: 'Other',
};

export type RemoveConnectionSourceResult =
  | {
    ok: true;
    remaining: ConnectionSource[];
    /** A source that isn't suspended still holds it. */
    stillConnected: boolean;
    /** Sources that couldn't be read, so they may still hold it. */
    unreadable?: string[];
    /** The removal is kept for now but couldn't be saved: it may come back after a restart. */
    notSaved?: boolean;
  }
  | { ok: false; error: string };
