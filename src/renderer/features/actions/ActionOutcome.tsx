/** Pure outcome and time presentation, shared by editable and read-only action rows. */
import type { ActionRun } from '../../../shared/actions';

const OUTCOME_WORDS: Record<ActionRun['outcome'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Couldn’t run',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  throttled: 'Throttled',
  expired: 'Expired',
};

const OUTCOME_DOT: Record<ActionRun['outcome'], string> = {
  running: 'bg-ctp-accent',
  done: 'bg-ctp-green',
  failed: 'bg-ctp-red',
  cancelled: 'bg-surface-2',
  skipped: 'bg-surface-2',
  throttled: 'bg-surface-2',
  expired: 'bg-surface-2',
};

export function OutcomeDot({ outcome }: { outcome: ActionRun['outcome'] }) {
  return <span aria-hidden="true" className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${OUTCOME_DOT[outcome]}`} />;
}

export function outcomeWords(outcome: ActionRun['outcome']): string {
  return OUTCOME_WORDS[outcome];
}

export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

