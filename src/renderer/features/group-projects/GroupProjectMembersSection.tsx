import { useCallback, useEffect, useState } from 'react';
import type { GroupProjectMembershipView, ResolvedGroupProjectMember } from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';

/**
 * A group project's members, exclusions and the one-time auto-join offer
 * (#3357), read from its membership record. Self-contained: the directory
 * mounts it for the selected group project.
 */

function memberDetail(member: ResolvedGroupProjectMember): string {
  const kind = member.kind === 'helper' ? 'Helper' : member.kind === 'quick' ? 'Quick agent, this run only' : 'Agent';
  const how = member.via === 'auto' ? 'joined by being in scope' : 'added';
  return [kind, how, member.projectName].filter(Boolean).join(', ');
}

function names(members: ResolvedGroupProjectMember[]): string {
  return members.map((m) => m.name).join(', ');
}

export function GroupProjectMembersSection({ groupProjectId }: { groupProjectId: string }) {
  const [view, setView] = useState<GroupProjectMembershipView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await window.clubhouse.groupProject.listMembers(groupProjectId));
      setLoadError(null);
    } catch (err) {
      // telemetry-exempt: shown inline with a retry; the record is unchanged.
      setLoadError(ipcErrorMessage(err));
    }
  }, [groupProjectId]);

  useEffect(() => {
    setView(null);
    setActionError(null);
    void load();
    return window.clubhouse.groupProject.onMembershipChanged((id) => {
      if (id === groupProjectId) void load();
    });
  }, [groupProjectId, load]);

  const act = async (run: () => Promise<GroupProjectMembershipView>, failed: string) => {
    setBusy(true);
    setActionError(null);
    try {
      setView(await run());
    } catch (err) {
      // telemetry-exempt: shown inline; nothing was changed.
      setActionError(`${failed} ${ipcErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const api = window.clubhouse.groupProject;

  return (
    <SettingsSection title="Members">
      <SettingsBlock>
        {loadError && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className={settingsError}>Members couldn't be loaded. {loadError}</p>
            <Button onClick={() => void load()}>Retry</Button>
          </div>
        )}
        {!loadError && !view && <p role="status" className={settingsHelp}>Loading members...</p>}
        {view && (
          <div className="flex flex-col gap-3">
            {!view.managed && (
              <p className={settingsHelp}>
                {view.deferred ?? 'Members still come from Canvas wires. They move to this list the next time Clubhouse starts.'}
              </p>
            )}
            {view.managed && (
              <p className={settingsHelp}>
                {view.autoJoin
                  ? 'Every top-level agent in scope is a member, including agents created later, unless excluded. Helpers and quick agents join only when added.'
                  : 'Only the agents listed here are members.'}
              </p>
            )}
            {view.autoJoinOffer?.state === 'pending' && (
              <div className="flex flex-col items-start gap-2">
                <p className={settingsHelp}>
                  {view.autoJoinOffer.wouldJoin.length > 0
                    ? `Include every agent in scope? ${view.autoJoinOffer.wouldJoin.length} would join: ${names(view.autoJoinOffer.wouldJoin)}.`
                    : 'Include every agent in scope? Nobody else would join now, but agents created later would.'}
                </p>
                <div className="flex gap-2">
                  <Button kind="primary" disabled={busy} onClick={() => void act(() => api.answerAutoJoinOffer(groupProjectId, true), 'Not changed.')}>
                    Include every agent in scope
                  </Button>
                  <Button disabled={busy} onClick={() => void act(() => api.answerAutoJoinOffer(groupProjectId, false), 'Not changed.')}>
                    Keep current members
                  </Button>
                </div>
              </div>
            )}
            {view.members.length === 0
              ? <p className={settingsHelp}>No members.</p>
              : (
                <ul aria-label="Members" className="flex flex-col gap-1">
                  {view.members.map((member) => (
                    <li key={member.agentId} className="flex items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="text-sm text-ctp-text">{member.name}</span>
                        <span className={`${settingsHelp} block`}>{memberDetail(member)}</span>
                      </span>
                      <Button
                        disabled={busy}
                        aria-label={`${member.kind === 'durable' ? 'Exclude' : 'Remove'} ${member.name}`}
                        onClick={() => void act(() => api.excludeMember(groupProjectId, member.agentId), 'Not changed.')}
                      >
                        {member.kind === 'durable' ? 'Exclude' : 'Remove'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            {view.excluded.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className={settingsHelp}>Excluded. These agents don't join automatically.</p>
                <ul aria-label="Excluded agents" className="flex flex-col gap-1">
                  {view.excluded.map((entry) => (
                    <li key={entry.agentId} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-ctp-text">{entry.name}</span>
                      <Button
                        disabled={busy}
                        aria-label={`Include ${entry.name} again`}
                        onClick={() => void act(() => api.addMember(groupProjectId, entry.agentId), 'Not changed.')}
                      >
                        Include again
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {actionError && <p role="alert" className={settingsError}>{actionError}</p>}
          </div>
        )}
      </SettingsBlock>
    </SettingsSection>
  );
}
