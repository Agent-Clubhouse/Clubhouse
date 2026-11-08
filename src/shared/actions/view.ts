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
}
