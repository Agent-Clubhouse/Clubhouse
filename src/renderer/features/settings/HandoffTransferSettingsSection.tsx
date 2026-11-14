import { useEffect, useState } from 'react';
import type { HandoffTransferBounds } from '../../../shared/handoff-manifest';
import { Button } from '../../components/Button';
import { SettingsSection, settingsInput } from './SettingsLayout';

const MiB = 1024 ** 2;
export function HandoffTransferSettingsSection({ projectId }: { projectId: string }) {
  const [saved, setSaved] = useState<HandoffTransferBounds>();
  const [total, setTotal] = useState('');
  const [perFile, setPerFile] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function loaded(value: HandoffTransferBounds) { setSaved(value); setTotal(String(value.totalBytes / MiB)); setPerFile(String(value.perFileBytes / MiB)); }
  useEffect(() => {
    let active = true;
    setSaved(undefined); setError('');
    Promise.resolve().then(() => window.clubhouse.project.getHandoffTransferBounds(projectId)).then((value) => { if (active) loaded(value); })
      .catch(() => { if (active) setError('Handoff transfer limits could not be loaded.'); });
    return () => { active = false; };
  }, [projectId]);
  async function save() {
    if (!saved) return;
    setBusy(true); setError('');
    try { loaded(await window.clubhouse.project.setHandoffTransferBounds(projectId, { totalBytes: Number(total) * MiB, perFileBytes: Number(perFile) * MiB, maxFiles: saved.maxFiles })); }
    catch { setError('Limits were not saved. Choose positive values up to 16,384 MiB, with the per-file limit no greater than the total.'); /* telemetry-exempt: bounded user-facing validation message */ }
    finally { setBusy(false); }
  }
  const changed = saved && (Number(total) * MiB !== saved.totalBytes || Number(perFile) * MiB !== saved.perFileBytes);
  return <SettingsSection title="Handoff transfer limits">
    <p className="text-xs text-ctp-overlay1 pb-2">Limits apply to handoffs sent or received in this project. Only you can change them. The default total is 1 GiB, with 256 MiB per file.</p>
    <label className="text-sm" htmlFor="handoff-total-mib">Total limit (MiB)</label>
    <input id="handoff-total-mib" type="number" min="1" max="16384" className={settingsInput} value={total} disabled={!saved || busy} onChange={(event) => setTotal(event.target.value)} />
    <label className="text-sm" htmlFor="handoff-per-file-mib">Per-file limit (MiB)</label>
    <input id="handoff-per-file-mib" type="number" min="1" max="16384" className={settingsInput} value={perFile} disabled={!saved || busy} onChange={(event) => setPerFile(event.target.value)} />
    <Button kind="primary" disabled={!changed || busy} onClick={() => void save()}>Save transfer limits</Button>
    {error && <p role="alert" className="text-sm text-ctp-red">{error}</p>}
  </SettingsSection>;
}
