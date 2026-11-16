import { useCallback, useEffect, useState } from 'react';
import type { GroupProjectMembershipView, GroupProjectRolesView } from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';
import type { GroupProjectRosterView } from '../../../shared/group-project-roster';
import { isCopyRoster, rosterGaps, rosterUnavailableText, rosterVouched, time, useGroupRoster, useIsCopy } from './useGroupRoster';

/**
 * The group project as a principal (#3360): what it may do by itself, and who
 * leads and administers it. Both are grants: no agent leads by default, the
 * creator included. Self-contained; the directory mounts it for the selected
 * group project.
 */

type Mode = 'allow' | 'ask' | 'off';
const MODE_LABEL: Readonly<Record<Mode, string>> = { allow: 'Allow', ask: 'Ask first', off: 'Off' };

function ModeSelect({ label, value, disabled, onChange }: { label: string; value: Mode; disabled: boolean; onChange: (mode: Mode) => void }) {
  return (
    <select
      aria-label={label}
      className="text-xs bg-surface-0 text-ctp-text rounded px-1.5 py-0.5"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Mode)}
    >
      {(['allow', 'ask', 'off'] as const).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
    </select>
  );
}

export function GroupProjectRolesSection({ groupProjectId }: { groupProjectId: string }) {
  const [roles, setRoles] = useState<GroupProjectRolesView | null>(null);
  const [members, setMembers] = useState<GroupProjectMembershipView['members']>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const api = window.clubhouse.groupProject;
  // #3548: the roles the host enforces, for every member on every computer.
  const roster = useGroupRoster(groupProjectId, members);
  const where = useIsCopy(groupProjectId);
  const copy = where.copy || isCopyRoster(roster);
  const hostName = roster?.hostName ?? where.hostName;

  const load = useCallback(async () => {
    try {
      const [r, m] = await Promise.all([api.getRoles(groupProjectId), api.listMembers(groupProjectId)]);
      setRoles(r);
      setMembers(m.members);
      setError(null);
    } catch (err) {
      // telemetry-exempt: shown inline with a retry; nothing changed.
      setError(`Permissions couldn't be loaded. ${ipcErrorMessage(err)}`);
    }
  }, [api, groupProjectId]);

  useEffect(() => {
    setRoles(null);
    void load();
    return api.onMembershipChanged((id) => { if (id === groupProjectId) void load(); });
  }, [api, groupProjectId, load]);

  const change = async (run: () => Promise<GroupProjectRolesView>) => {
    setBusy(true);
    setError(null);
    try {
      setRoles(await run());
    } catch (err) {
      // telemetry-exempt: shown inline; nothing changed.
      setError(`Not changed. ${ipcErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const holder = (agentId: string) => roles?.holders.find((h) => h.agentId === agentId);
  /** Which computer a member is on, when the roster says it's another one. */
  const elsewhere = (agentId: string): string | undefined => {
    if (roster?.status !== 'available') return undefined;
    const found = roster.members.find((r) => !r.thisComputer && `${r.agentId}@${r.machine}` === agentId);
    return found?.machineLabel;
  };
  const nameOf = (m: { agentId: string; name: string }) => {
    const where = elsewhere(m.agentId);
    return where ? `${m.name} on ${where}` : m.name;
  };

  return (
    <SettingsSection title="Permissions">
      <SettingsBlock>
        {!roles && !error && <p role="status" className={settingsHelp}>Loading permissions...</p>}
        {error && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className={settingsError}>{error}</p>
            {!roles && <Button onClick={() => void load()}>Retry</Button>}
          </div>
        )}
        {roles && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className={settingsHelp}>What the group project does by itself.</p>
              {([
                ['deliver', 'Tell members about new posts'],
                ['wake', 'Wake sleeping members'],
                ['actions', 'Run group project Actions'],
              ] as const).map(([grant, label]) => (
                <label key={grant} className="flex items-center justify-between gap-2 text-sm text-ctp-text">
                  {label}
                  <select
                    aria-label={label}
                    className="text-xs bg-surface-0 text-ctp-text rounded px-1.5 py-0.5"
                    value={roles.own[grant]}
                    disabled={busy}
                    onChange={(e) => void change(() => api.setOwnGrant(groupProjectId, grant, e.target.value as 'allow' | 'off'))}
                  >
                    <option value="allow">Allow</option>
                    <option value="off">Off</option>
                  </select>
                </label>
              ))}
            </div>
            {copy && <HostRoles roster={roster} hostName={hostName} />}
            <div className="flex flex-col gap-1">
              {copy && (
                <p className={settingsHelp} data-testid="roles-this-computer">
                  On this computer. These grants cover lead tools that agents here run, such as tapping, waking or
                  broadcasting to members. {hostName} doesn't use them when it applies a change, so the two lists can differ.
                </p>
              )}
              <p className={settingsHelp}>
                A lead can broadcast, tap, wake and put members to sleep, and tidy the board. An admin can change the
                group project itself. No agent has either until you give it here or on the permissions page.
              </p>
              {members.length === 0 && <p className={settingsHelp}>No members.</p>}
              {members.length > 0 && (
                <ul aria-label="Lead and admin" className="flex flex-col gap-1">
                  {members.map((m) => (
                    <li key={m.agentId} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-ctp-text min-w-0 truncate">{nameOf(m)}</span>
                      <span className="flex items-center gap-2">
                        <ModeSelect
                          label={`Lead for ${nameOf(m)}`}
                          value={holder(m.agentId)?.lead ?? 'off'}
                          disabled={busy}
                          onChange={(mode) => void change(() => api.setRole(groupProjectId, m.agentId, 'lead', mode))}
                        />
                        <ModeSelect
                          label={`Admin for ${nameOf(m)}`}
                          value={holder(m.agentId)?.admin ?? 'off'}
                          disabled={busy}
                          onChange={(mode) => void change(() => api.setRole(groupProjectId, m.agentId, 'admin', mode))}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </SettingsBlock>
    </SettingsSection>
  );
}

/**
 * On a copy: lead and admin as the host has them (#3548). Read-only here: a
 * change from another computer can't set the host's grants, and Ask first
 * can't be answered for one.
 */
function HostRoles({ roster, hostName }: { roster: GroupProjectRosterView | null; hostName: string }) {
  const host = roster?.hostName ?? hostName;
  if (!roster) {
    return (
      <div className="flex flex-col gap-1" data-testid="roles-host-checking">
        <p className={settingsHelp}>Checking {host} for its lead and admin grants. Until it answers, only this computer's grants are shown.</p>
      </div>
    );
  }
  if (roster.status === 'unavailable') {
    return (
      <div className="flex flex-col gap-1" data-testid="roles-host-unavailable">
        <p className={settingsHelp}>Lead and admin on {host} can't be shown. {rosterUnavailableText(roster)}</p>
      </div>
    );
  }
  const gaps = rosterGaps(roster);
  return (
    <div className="flex flex-col gap-1" data-testid="roles-host">
      <p className={settingsHelp}>
        Lead and admin on {host}, as of {time(roster.fetchedAt)}. {host} checks these when it applies a change from any computer, such as deleting a
        post or changing members. They're set on {host} and can't be changed from here.
      </p>
      {!rosterVouched(roster) && (
        <div className="flex flex-col gap-0.5" role="status" aria-label="Role list may be incomplete">
          <p className={settingsHelp}>This list may be incomplete.</p>
          {gaps.map((gap) => <p key={gap} className={settingsHelp}>{gap}</p>)}
        </div>
      )}
      {roster.members.length === 0
        ? <p className={settingsHelp}>No members.</p>
        : (
          <ul aria-label={`Lead and admin on ${host}`} className="flex flex-col gap-1">
            {roster.members.map((m) => {
              const name = m.thisComputer ? m.label : `${m.label} on ${m.machineLabel}`;
              return (
                <li key={m.key} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-ctp-text min-w-0 truncate">{name}</span>
                  <span className="flex items-center gap-3 text-xs text-ctp-subtext1">
                    <span aria-label={`Lead for ${name} on ${host}`}>Lead {MODE_LABEL[m.lead].toLowerCase()}</span>
                    <span aria-label={`Admin for ${name} on ${host}`}>Admin {MODE_LABEL[m.admin].toLowerCase()}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
