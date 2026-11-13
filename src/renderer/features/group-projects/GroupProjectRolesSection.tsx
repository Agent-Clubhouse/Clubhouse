import { useCallback, useEffect, useState } from 'react';
import type { GroupProjectMembershipView, GroupProjectRolesView } from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';

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
                ['wake', 'Wake a sleeping member when a lead taps it'],
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
            <div className="flex flex-col gap-1">
              <p className={settingsHelp}>
                A lead can broadcast, tap, wake and put members to sleep, and tidy the board. An admin can change the
                group project itself. No agent has either until you give it here or on the permissions page.
              </p>
              {members.length === 0 && <p className={settingsHelp}>No members.</p>}
              {members.length > 0 && (
                <ul aria-label="Lead and admin" className="flex flex-col gap-1">
                  {members.map((m) => (
                    <li key={m.agentId} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-ctp-text min-w-0 truncate">{m.name}</span>
                      <span className="flex items-center gap-2">
                        <ModeSelect
                          label={`Lead for ${m.name}`}
                          value={holder(m.agentId)?.lead ?? 'off'}
                          disabled={busy}
                          onChange={(mode) => void change(() => api.setRole(groupProjectId, m.agentId, 'lead', mode))}
                        />
                        <ModeSelect
                          label={`Admin for ${m.name}`}
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
