import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutoJoinPreview, GroupProjectMembershipOptions, GroupProjectMembershipView, ResolvedGroupProjectMember } from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';
import { CoverageSummary } from './CoverageSummary';
import { GroupOperationStatus } from './GroupOperationStatus';
import { useOneGroupCoverage } from './useGroupCoverage';
import { isCopyRoster, rosterGaps, rosterMemberDetail, rosterUnavailableText, rosterVouched, time, useGroupRoster, useIsCopy } from './useGroupRoster';
import type { GroupProjectRosterView } from '../../../shared/group-project-roster';

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
  return members.map((m) => `${m.name}${m.projectName ? ` (${m.projectName})` : ''}`).join(', ');
}

export function GroupProjectMembersSection({ groupProjectId }: { groupProjectId: string }) {
  const currentGroup = useRef(groupProjectId);
  currentGroup.current = groupProjectId;
  const [view, setView] = useState<GroupProjectMembershipView | null>(null);
  // Read again whenever the list is: a membership or link change reloads both.
  const coverage = useOneGroupCoverage(groupProjectId, view);
  // #3548: every member on every computer, from the host.
  const roster = useGroupRoster(groupProjectId, view);
  const where = useIsCopy(groupProjectId);
  const copy = where.copy || isCopyRoster(roster);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ options: GroupProjectMembershipOptions; preview: AutoJoinPreview } | null>(null);
  const [unlinkReview, setUnlinkReview] = useState<ResolvedGroupProjectMember[] | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await window.clubhouse.groupProject.listMembers(groupProjectId);
      if (currentGroup.current !== groupProjectId) return;
      setView(result);
      setLoadError(null);
    } catch (err) {
      // telemetry-exempt: shown inline with a retry; the record is unchanged.
      if (currentGroup.current === groupProjectId) setLoadError(ipcErrorMessage(err));
    }
  }, [groupProjectId]);

  useEffect(() => {
    setView(null);
    setLoadError(null);
    setBusy(false);
    setActionError(null);
    setReview(null);
    setUnlinkReview(null);
    void load();
    return window.clubhouse.groupProject.onMembershipChanged((id) => {
      if (id === groupProjectId) void load();
    });
  }, [groupProjectId, load]);

  const act = async (run: () => Promise<GroupProjectMembershipView>, failed: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await run();
      if (currentGroup.current === groupProjectId) setView(result);
    } catch (err) {
      // telemetry-exempt: shown inline; nothing was changed.
      if (currentGroup.current === groupProjectId) setActionError(`${failed} ${ipcErrorMessage(err)}`);
    } finally {
      if (currentGroup.current === groupProjectId) setBusy(false);
    }
  };

  const api = window.clubhouse.groupProject;
  const reviewAutomatic = async (options: GroupProjectMembershipOptions) => {
    if (!view?.automaticMembership) return;
    setBusy(true);
    setActionError(null);
    try {
      const preview = await api.previewAutoJoin(view.automaticMembership.scope, {
        ...options, excluded: view.excluded.map((entry) => entry.agentId),
      });
      if (currentGroup.current === groupProjectId) setReview({ options, preview });
    } catch (err) {
      // telemetry-exempt: the policy is unchanged, with the preview failure shown inline.
      if (currentGroup.current === groupProjectId) setActionError(`Could not review this change. ${ipcErrorMessage(err)}`);
    } finally { if (currentGroup.current === groupProjectId) setBusy(false); }
  };

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
                {view.deferred ?? 'Members still come from Canvas connections. They move to this list the next time Clubhouse starts.'}
              </p>
            )}
            {view.managed && (
              <p className={settingsHelp}>
                {view.autoJoin
                  ? view.automaticMembership
                    ? 'Top-level agents in this project join now and later, unless excluded. Agents on linked computers follow the toggle below. Helpers and quick agents join only when added.'
                    : 'Every top-level agent in scope is a member, including agents created later, unless excluded. Helpers and quick agents join only when added.'
                  : 'Only the agents listed here are members.'}
              </p>
            )}
            <CoverageSummary coverage={coverage} />
            {view.automaticMembership && <div className="flex flex-col items-start gap-2">
              {!view.automaticMembership.editable && <p className={settingsHelp}>Only the computer that holds this group project can change automatic membership.</p>}
              <label className="flex items-center gap-2 text-xs text-ctp-text"><input type="checkbox" checked={view.autoJoin} disabled={busy || !view.automaticMembership.editable}
                onChange={(event) => void reviewAutomatic({ autoJoin: event.target.checked, includeLinkedComputers: view.includeLinkedComputers ?? false })} />
                Start with every agent in {view.automaticMembership.projectName}
              </label>
              {view.automaticMembership.scope.reach === 'network' && <label className="flex items-center gap-2 text-xs text-ctp-text"><input type="checkbox" checked={view.includeLinkedComputers ?? false} disabled={busy || !view.autoJoin || !view.automaticMembership.editable}
                onChange={(event) => void reviewAutomatic({ autoJoin: view.autoJoin, includeLinkedComputers: event.target.checked })} />Include linked computers</label>}
              <p className={settingsHelp}>Keeps adding eligible agents created later. Turning either toggle off keeps current members as explicitly added members. Exclusions stay.</p>
            </div>}
            {review && <div role="region" aria-label="Automatic membership review" className="flex flex-col items-start gap-2">
              <p className={settingsHelp}>{!review.options.autoJoin ? 'Current members stay. New agents stop joining automatically.' : view.includeLinkedComputers && !review.options.includeLinkedComputers ? 'Current members stay. Agents on linked computers stop joining automatically. Agents in this project on this computer keep joining.' : `Agents who would join: ${names(review.preview.wouldJoin.filter((agent) => !view.members.some((m) => m.agentId === agent.agentId))) || 'None now'}.`}</p>
              {review.preview.unreadableProjects.length > 0 && <p className={settingsHelp}>Could not check: {review.preview.unreadableProjects.map((p) => p.name).join(', ')}. The preview may be incomplete.</p>}
              {!!view.coverageLeaving?.length && <p className={settingsHelp}>Review who leaves the unlinked project copy before changing automatic membership.</p>}
              <Button disabled={busy || !!view.coverageLeaving?.length} onClick={() => void act(async () => { const result = await api.setAutomaticMembership(groupProjectId, review.options); if (currentGroup.current === groupProjectId) setReview(null); return result; }, 'Not changed.')}>Apply automatic membership</Button>
              <Button disabled={busy} onClick={() => setReview(null)}>Cancel</Button>
            </div>}
            {!!view.coverageLeaving?.length && <div className="flex flex-col items-start gap-2">
              <p className={settingsHelp}>A project copy was unlinked. Its automatic members stay until you review who leaves.</p>
              <Button disabled={busy || !view.automaticMembership?.editable} onClick={() => setUnlinkReview(view.coverageLeaving ?? [])}>Review linked membership</Button>
            </div>}
            {unlinkReview && <div role="region" aria-label="Linked membership review" className="flex flex-col items-start gap-2">
              <p className={settingsHelp}>These members leave: {unlinkReview.map((member) => `${member.name}${member.projectName ? ` (${member.projectName})` : ''}`).join(', ')}.</p>
              <Button disabled={busy} onClick={() => void act(async () => {
                try { return await api.confirmUnlinkedMembers(groupProjectId, unlinkReview.map((m) => m.agentId)); }
                finally { if (currentGroup.current === groupProjectId) { setUnlinkReview(null); void load(); } }
              }, 'Membership not changed. Review again.')}>Apply and remove {unlinkReview.length}</Button>
              <Button disabled={busy} onClick={() => setUnlinkReview(null)}>Cancel</Button>
            </div>}
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
            {roster?.status === 'available'
              ? <RosterMembers roster={roster} view={view} busy={busy} onRemove={(agentId) => void act(() => api.excludeMember(groupProjectId, agentId), 'Not changed.')} />
              : <>
            {copy && (
              <p className={settingsHelp} data-testid="members-local-only">
                Members on this computer. {roster?.status === 'unavailable'
                  ? `${rosterUnavailableText(roster)} Members on other computers aren't shown.`
                  : `Checking ${where.hostName} for members on other computers.`}
              </p>
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
              </>}
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
            <GroupOperationStatus groupProjectId={groupProjectId} sections={['members']} label="Membership changes" />
            {actionError && <p role="alert" className={settingsError}>{actionError}</p>}
          </div>
        )}
      </SettingsBlock>
    </SettingsSection>
  );
}

/**
 * The host's roster (#3548). Says what it can't vouch for, and offers Exclude
 * or Remove only where this computer can make that change today: on the host
 * for every member, on a copy for this computer's own agents.
 */
function RosterMembers({ roster, view, busy, onRemove }: {
  roster: Extract<GroupProjectRosterView, { status: 'available' }>;
  view: GroupProjectMembershipView;
  busy: boolean;
  onRemove: (agentId: string) => void;
}) {
  const copy = roster.source !== 'host';
  const gaps = rosterGaps(roster);
  const vouched = rosterVouched(roster);
  const local = new Set(view.members.map((m) => m.agentId));
  const actionId = (m: (typeof roster.members)[number]): string | null => {
    const id = m.thisComputer ? m.agentId : copy ? null : `${m.agentId}@${m.machine}`;
    return id && local.has(id) ? id : null;
  };
  const elsewhere = copy && roster.members.some((m) => !m.thisComputer);
  return (
    <div className="flex flex-col gap-2" data-testid="members-roster">
      {vouched
        ? <p className={settingsHelp}>
          {copy ? `Every member on every computer, from ${roster.hostName}, as of ${time(roster.fetchedAt)}.` : 'Every member on every computer.'}
        </p>
        : <div className="flex flex-col gap-0.5" role="status" aria-label="Member list may be incomplete">
          <p className={settingsHelp}>This list may be incomplete.</p>
          {gaps.map((gap) => <p key={gap} className={settingsHelp}>{gap}</p>)}
        </div>}
      {elsewhere && <p className={settingsHelp}>Members on other computers can be changed on {roster.hostName}.</p>}
      {roster.members.length === 0
        ? <p className={settingsHelp}>No members.</p>
        : (
          <ul aria-label="Members" className="flex flex-col gap-1">
            {roster.members.map((member) => {
              const id = actionId(member);
              return (
                <li key={member.key} className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="text-sm text-ctp-text">{member.label}</span>
                    <span className={`${settingsHelp} block`}>{rosterMemberDetail(member)}</span>
                  </span>
                  {id && (
                    <Button
                      disabled={busy}
                      aria-label={`${member.kind === 'durable' ? 'Exclude' : 'Remove'} ${member.label} on ${member.machineLabel}`}
                      onClick={() => onRemove(id)}
                    >
                      {member.kind === 'durable' ? 'Exclude' : 'Remove'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
