import { useEffect, useState } from 'react';
import { RETIRED_PLUGINS } from '../../../shared/retired-plugins';
import { Button } from '../../components/Button';
import { SettingsSection, settingsHelp } from './SettingsLayout';

type DataState = { kind: 'loading' } | { kind: 'ready'; dirs: string[] } | { kind: 'failed' };

/**
 * A retired Workshop plugin's page (#2756): what replaced it, where its data
 * is, and a way to export a copy. Nothing here deletes data.
 */
export function RetiredPluginSection({ pluginId }: { pluginId: string }) {
  const retired = RETIRED_PLUGINS[pluginId];
  const [data, setData] = useState<DataState>({ kind: 'loading' });
  const [exportResult, setExportResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.clubhouse.plugin.findRetiredData(pluginId)
      .then((result) => { if (!cancelled) setData({ kind: 'ready', dirs: result.locations.map((l) => l.dir) }); })
      .catch(() => { if (!cancelled) setData({ kind: 'failed' }); });
    return () => { cancelled = true; };
  }, [pluginId]);

  if (!retired) return null;

  const exportData = async () => {
    setExportResult(null);
    try {
      const result = await window.clubhouse.plugin.exportRetiredData(pluginId);
      if (result.canceled) return;
      setExportResult(result.error ? `Couldn't export: ${result.error}` : `Exported to ${result.filePath}.`);
    } catch (err) { // telemetry-exempt: shown to the person; main logs the export failure
      setExportResult(`Couldn't export: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <SettingsSection title="Retired">
      <div className="py-2.5 border-t border-surface-0 flex flex-col gap-2" data-testid="retired-plugin-section">
        <p className={settingsHelp}>
          {retired.name} was retired in Clubhouse 1.0 and no longer loads. {retired.replacement}
        </p>
        {data.kind === 'ready' && data.dirs.length === 0 && (
          <p className={settingsHelp}>It left no data on this computer.</p>
        )}
        {data.kind === 'ready' && data.dirs.length > 0 && (
          <>
            <p className={settingsHelp}>Its data is kept where it was. Uninstalling the plugin keeps it too.</p>
            <ul className="text-xs text-ctp-subtext0 font-mono flex flex-col gap-0.5" data-testid="retired-plugin-dirs">
              {data.dirs.map((dir) => <li key={dir} className="break-all">{dir}</li>)}
            </ul>
            <div className="flex gap-2">
              <Button kind="primary" onClick={() => { void exportData(); }} data-testid="retired-plugin-export">Export data…</Button>
              <Button onClick={() => { void window.clubhouse.plugin.revealRetiredData(pluginId); }}>Show in folder</Button>
            </div>
          </>
        )}
        {data.kind === 'failed' && <p className={settingsHelp}>Couldn&apos;t look for its data.</p>}
        {exportResult && <p className={settingsHelp} role="status">{exportResult}</p>}
      </div>
    </SettingsSection>
  );
}
