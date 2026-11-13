import { useEffect, useState } from 'react';
import type { HandoffSecretSettings } from '../../../shared/handoff-secret-settings';
import type { ActionRun } from '../../../shared/actions';
import { Button } from '../../components/Button';
import { SettingsSection, settingsInput } from './SettingsLayout';

export function HandoffSecretSettingsSection({ projectId }: { projectId: string }) {
  const [saved, setSaved] = useState<HandoffSecretSettings>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ActionRun[]>();
  useEffect(() => {
    let active = true;
    setSaved(undefined); setText(''); setError(''); setHistory(undefined);
    Promise.resolve().then(() => window.clubhouse.project.getHandoffSecretSettings(projectId)).then((value) => {
      if (active) { setSaved(value); setText(value.notSecretPaths.join('\n')); }
    }).catch(() => { if (active) setError('Handoff secret settings could not be loaded.'); });
    return () => { active = false; };
  }, [projectId]);
  async function save() {
    setBusy(true); setError('');
    try {
      const next = await window.clubhouse.project.setHandoffSecretSettings(projectId, text.split('\n').map((line) => line.trim()).filter(Boolean));
      setSaved(next); setText(next.notSecretPaths.join('\n')); setHistory(undefined);
    } catch {
      // telemetry-exempt: generic error is shown; raw diagnostics may contain secret file names.
      setError('Exceptions were not saved. Use at most 100 unique, exact relative file paths. Action history must be available.');
    }
    finally { setBusy(false); }
  }
  async function showHistory() {
    try { setHistory((await Promise.all((saved?.historyActionIds ?? []).map((id) => window.clubhouse.actions.history(id)))).flat()); }
    catch {
      // telemetry-exempt: show a bounded error without private history details.
      setError('Handoff exception history could not be loaded.');
    }
  }
  return <SettingsSection title="Handoff secret exceptions">
    <p className="text-xs text-ctp-overlay1 pb-2">Handoffs check every selected file for secrets. Only you can confirm that a flagged file is non-secret, such as a test fixture. Each confirmation and use is recorded in action history. Exceptions apply only to this project on this computer.</p>
    <label htmlFor="handoff-not-secret-paths" className="text-sm">Confirmed non-secret paths</label>
    <textarea id="handoff-not-secret-paths" className={`${settingsInput} w-full min-h-24`} value={text} disabled={!saved || busy} onChange={(event) => setText(event.target.value)} placeholder="One exact relative file path per line" />
    <p className="text-xs text-ctp-overlay1 pb-2">No wildcards or folders. Clear the list to revoke all exceptions.</p>
    <Button kind="primary" disabled={!saved || busy || text === saved.notSecretPaths.join('\n')} onClick={() => void save()}>Confirm non-secret paths</Button>
    {!!saved?.historyActionIds.length && <Button kind="ghost" onClick={() => void showHistory()}>View exception history</Button>}
    {error && <p role="alert" className="text-sm text-ctp-red">{error}</p>}
    {history && <ul className="text-xs">{history.map((run) => <li key={run.id}>{new Date(run.startedAt).toLocaleString()}: {run.reason}<pre className="whitespace-pre-wrap">{run.steps.map((step) => step.detail).join('\n')}</pre></li>)}</ul>}
  </SettingsSection>;
}
