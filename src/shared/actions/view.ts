import type { Action, ActionRun } from './types';

/** What the UI shows for an action: the action plus its live status. */
export interface ActionView extends Action {
  /** When a schedule or one-time action runs next. */
  nextRunAt?: number;
  /** A run is going now. */
  running: boolean;
  lastRun?: ActionRun;
}

/** A toast: a mechanical failure, or an action Clubhouse turned off. */
export interface ActionNotice {
  actionId: string;
  name: string;
  message: string;
  /** False for a one-time action that already deleted itself: there is no card to open. */
  exists: boolean;
}

/** A host's read-only summary shared with its Annex Network peers. */
export interface RemoteGroupAction {
  id: string;
  name: string;
  groupProjectId: string;
  groupProjectName: string;
  enabled: boolean;
  /** A plain-language trigger and step summary; absent on older hosts. */
  description?: string;
}
