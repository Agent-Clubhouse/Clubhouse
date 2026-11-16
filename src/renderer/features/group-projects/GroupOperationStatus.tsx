import { useEffect } from 'react';
import type { GroupOperationSection, GroupProjectOperation } from '../../../shared/group-project-types';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { settingsError, settingsHelp } from '../settings/SettingsLayout';
import { time } from './useGroupRoster';

/** Most changes listed under one section; the rest are counted. */
const SHOWN_MAX = 5;

const LABELS: Record<string, string> = {
  post: 'Post',
  update: 'Details change',
  membership: 'Membership change',
  deleteMessage: 'Message deletion',
  deleteTopic: 'Topic deletion',
  setTopicProtected: 'Topic protection change',
};

export const operationLabel = (op: string): string => LABELS[op] ?? 'Change';

/** What became of one change, in the words the page uses: never "Saved" for one that only waits. */
export function operationStatusText(operation: GroupProjectOperation): string {
  const { outcome } = operation;
  if (outcome.status === 'queued') return `Waiting for ${outcome.waitingFor} since ${time(outcome.since)}`;
  if (outcome.status === 'applied') return 'Applied';
  return `Refused: ${outcome.reason}`;
}

/** This group project's changes in the given sections, from the host's bounded status read. */
export function useSectionOperations(groupProjectId: string, sections: readonly GroupOperationSection[]): GroupProjectOperation[] {
  const loadOperations = useGroupProjectStore((s) => s.loadOperations);
  const read = useGroupProjectStore((s) => s.operations[groupProjectId]);
  useEffect(() => { void loadOperations(groupProjectId); }, [groupProjectId, loadOperations]);
  return (read?.operations ?? []).filter((operation) => sections.includes(operation.section));
}

/**
 * Per-change status for one part of a group project's page (#3550): waiting for
 * the host, applied, or refused with why. Empty when nothing was forwarded.
 */
export function GroupOperationStatus({ groupProjectId, sections, label }: {
  groupProjectId: string;
  sections: readonly GroupOperationSection[];
  label: string;
}) {
  const operations = useSectionOperations(groupProjectId, sections);
  if (operations.length === 0) return null;
  const shown = operations.slice(-SHOWN_MAX).reverse();
  const hidden = operations.length - shown.length;
  return (
    <div className="flex flex-col gap-1" data-testid="group-operation-status">
      <ul aria-label={label} className="flex flex-col gap-0.5">
        {shown.map((operation) => (
          <li
            key={operation.id}
            data-status={operation.outcome.status}
            className={operation.outcome.status === 'refused' ? settingsError : settingsHelp}
          >
            {operationLabel(operation.op)}: {operationStatusText(operation)}
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className={settingsHelp}>and {hidden} more.</p>}
    </div>
  );
}
