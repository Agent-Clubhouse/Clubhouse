import { useState } from 'react';
import type { ActionChatSummary } from '../../../shared/actions';
import { Button } from '../../components/Button';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { settingsError } from '../settings/SettingsLayout';
import { openActionsSettings, useActionsList } from './useActions';

export function ActionSummaryCard({ summary }: { summary: ActionChatSummary }) {
  const { actions, error: loadError, reload } = useActionsList();
  const action = actions?.find((a) => a.id === summary.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = action?.enabled ?? summary.enabled;
  const gone = actions !== null && !action;
  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      // The same user IPC path as Settings, never an agent-origin MCP call.
      await window.clubhouse.actions.setEnabled(summary.id, false);
      reload();
    } catch (err) {
      // telemetry-exempt: shown on the card, with the control available to retry.
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border border-surface-0 rounded-lg p-3 text-[13px]" data-testid="chat-action-summary">
      <div className="font-medium text-ctp-text">{summary.name}</div>
      <div className="text-ctp-subtext0 mt-1">{summary.trigger}</div>
      <div className="text-ctp-subtext0">{summary.steps}</div>
      <div className="text-ctp-overlay1 mt-1">{gone ? 'No longer saved.' : enabled ? 'On' : 'Off'}</div>
      <div className="flex gap-2 mt-2">
        <Button kind="ghost" disabled={gone || !action} onClick={() => openActionsSettings({ cardId: summary.id })}>Open</Button>
        <Button kind="ghost" disabled={!action || !enabled || busy} onClick={() => { void turnOff(); }}>Turn off</Button>
      </div>
      {(error || loadError) && <div role="alert" className={`${settingsError} mt-2`}>{error || loadError}</div>}
    </div>
  );
}
