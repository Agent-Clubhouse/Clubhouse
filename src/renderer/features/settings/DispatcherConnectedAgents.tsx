/**
 * Connected agents on Settings › Dispatcher (#3046, the list from #2815): every
 * agent that can connect, across projects, with its Connect switch.
 *
 * The switch is the same one as on the agent's Dispatcher card in Details: both
 * write the agent's Connect setting through setOrchestrationPolicy, and the list
 * re-reads when any project's agent configs change, so a change on either shows
 * on the other. Nothing is written by opening the page. "Card" opens the agent
 * with its Dispatcher card expanded.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ConnectableAgent } from '../../../shared/dispatcher-settings-page';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { openAgent } from '../agents/helpers/orchestration-hooks';
import { useAgentDetailsStore } from '../agents/details/detailsStore';
import { onAgentCardChanged } from '../dispatcher/agent-card-client';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from './SettingsLayout';

/** Open an agent with Details showing and its Dispatcher card expanded. */
export function openAgentDispatcherCard(row: Pick<ConnectableAgent, 'projectId' | 'agentId'>): void {
  openAgent(row.projectId, row.agentId);
  useAgentDetailsStore.getState().reveal({ agentId: row.agentId, card: 'dispatcher' });
}

function useConnectableAgents(): { rows: ConnectableAgent[] | null; error: string | null; reload: () => void } {
  const [rows, setRows] = useState<ConnectableAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.dispatcher.listConnectableAgents()).then(
      (next) => { if (alive) { setRows(next); setError(null); } },
      // telemetry-exempt: shown above the list, with Retry.
      (err: unknown) => { if (alive) setError(ipcErrorMessage(err)); },
    );
    return () => { alive = false; };
  }, [nonce]);

  // A switch on an agent's card, a new agent or a new card all show here.
  useEffect(() => {
    const offConfigs = window.clubhouse.agent.onConfigsChanged?.(() => reload());
    const offCards = onAgentCardChanged(() => reload());
    return () => { offConfigs?.(); offCards(); };
  }, [reload]);

  return { rows, error, reload };
}

function AgentRow({ row, dispatcherName, onChanged }: { row: ConnectableAgent; dispatcherName: string; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown at once while main saves; the re-read then settles it.
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => { setPending(null); }, [row.connected]);
  const on = pending ?? row.connected;

  const setConnected = async (next: boolean) => {
    setSaving(true);
    setError(null);
    setPending(next);
    try {
      const result = await window.clubhouse.agent.setOrchestrationPolicy(row.projectPath, row.agentId, { connectToDispatcher: next });
      if (!result.ok) {
        setPending(null);
        setError(result.message || 'Couldn’t save. Try again.');
      }
    } catch (err) {
      // telemetry-exempt: shown on the row, which keeps the saved value.
      setPending(null);
      setError(`Couldn’t save. ${ipcErrorMessage(err)}`);
    } finally {
      setSaving(false);
      onChanged();
    }
  };

  const label = `${row.name} in ${row.projectName}`;
  return (
    <li className="flex items-center gap-3 py-2 border-t border-surface-0 first:border-t-0" data-testid={`dispatcher-agent-${row.agentId}`}>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-ctp-text truncate">
          {row.name}
          <span className="text-ctp-overlay1"> in {row.projectName}</span>
        </div>
        <div className={`${settingsHelp} truncate`} data-testid={`dispatcher-agent-${row.agentId}-summary`}>
          {on ? (row.purpose ?? 'Connected') : 'Not connected'}
        </div>
        {error && <p className={`${settingsError} mt-0.5`} role="alert">{error}</p>}
      </div>
      <Button
        kind="quiet"
        onClick={() => openAgentDispatcherCard(row)}
        aria-label={`Open the card for ${label}`}
        data-testid={`dispatcher-agent-${row.agentId}-card`}
      >
        Card
      </Button>
      <Toggle
        aria-label={`Connect ${label} to ${dispatcherName}`}
        checked={on}
        disabled={saving}
        onChange={(next) => void setConnected(next)}
        data-testid={`dispatcher-agent-${row.agentId}-switch`}
      />
    </li>
  );
}

export function ConnectedAgentsSection({ dispatcherName }: { dispatcherName: string }) {
  const { rows, error, reload } = useConnectableAgents();
  const count = rows?.filter((r) => r.connected).length ?? 0;

  return (
    <SettingsSection title="Connected agents" meta={rows && rows.length > 0 ? `${count} of ${rows.length}` : undefined}>
      <p className={settingsHelp}>
        {dispatcherName} can message, wake and check on the agents connected here. Each agent’s card in Details has the same switch.
      </p>
      <SettingsBlock className="mt-2">
        {error && !rows && (
          <div className="flex items-center gap-3">
            <p className={settingsError} role="alert" data-testid="dispatcher-agents-error">Couldn’t list your agents. {error}</p>
            <Button onClick={reload}>Retry</Button>
          </div>
        )}
        {!error && !rows && <p className={settingsHelp} role="status">Loading</p>}
        {rows && rows.length === 0 && (
          <p className={settingsHelp} data-testid="dispatcher-agents-empty">No agents yet. Agents you add to your projects show here.</p>
        )}
        {rows && rows.length > 0 && (
          <ul aria-label="Connected agents" data-testid="dispatcher-agents">
            {rows.map((row) => <AgentRow key={`${row.projectPath}:${row.agentId}`} row={row} dispatcherName={dispatcherName} onChanged={reload} />)}
          </ul>
        )}
      </SettingsBlock>
    </SettingsSection>
  );
}
