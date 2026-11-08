import { useEffect, useState } from 'react';
import { RETIRED_PLUGINS } from '../../../shared/retired-plugins';
import { usePluginStore } from '../../plugins/plugin-store';
import { Button } from '../../components/Button';
import { SettingsSection, settingsHelp } from './SettingsLayout';

type DataState = { kind: 'loading' } | { kind: 'ready'; dirs: string[] } | { kind: 'failed' };

/**
 * A retired Workshop plugin's page (#2756): what replaced it, where its data
 * is, and a way to export a copy. Nothing here deletes data.
 */
export function RetiredPluginSection({ pluginId }: { pluginId: string }) {
  return (
    <SettingsSection title="Retired">
      <RetiredPluginData pluginId={pluginId} />
    </SettingsSection>
  );
}

/**
 * Retired plugins that are no longer installed but left data behind, in the
 * plugin list (#2756). Uninstalling one keeps its data, so this is where it
 * can still be found and exported. Renders nothing when there is none.
 */
export function RetiredPluginDataSection() {
  const installedKey = usePluginStore((s) => Object.keys(RETIRED_PLUGINS).filter((id) => s.plugins[id]).join(','));
  const [withData, setWithData] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const installed = new Set(installedKey ? installedKey.split(',') : []);
    const candidates = Object.keys(RETIRED_PLUGINS).filter((id) => !installed.has(id));
    Promise.all(candidates.map((id) => window.clubhouse.plugin.findRetiredData(id)
      .then((r): string | null => (r.locations.length > 0 ? id : null))
      .catch((): null => null)))
      .then((ids) => { if (!cancelled) setWithData(ids.filter((id): id is string => id !== null)); });
    return () => { cancelled = true; };
  }, [installedKey]);

  if (withData.length === 0) return null;
  return (
    <SettingsSection title="Retired plugin data" meta={String(withData.length)}>
      <div data-testid="retired-plugin-data-section">
        {withData.map((id) => (
          <div key={id}>
            <h4 className="text-[13px] text-ctp-text pt-2.5">{RETIRED_PLUGINS[id].name}</h4>
            <RetiredPluginData pluginId={id} />
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function RetiredPluginData({ pluginId }: { pluginId: string }) {
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
    <div className="py-2.5 border-t border-surface-0 flex flex-col gap-2" data-testid={`retired-plugin-section-${pluginId}`}>
      <p className={settingsHelp}>
        {retired.name} was retired in Clubhouse 1.0 and no longer loads. {retired.replacement}
      </p>
      {data.kind === 'ready' && data.dirs.length === 0 && (
        <p className={settingsHelp}>It left no data on this computer.</p>
      )}
      {data.kind === 'ready' && data.dirs.length > 0 && (
        <>
          <p className={settingsHelp}>Its data is kept where it was. Uninstalling the plugin keeps it too, and Settings &gt; Plugins still lists it for export.</p>
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
  );
}
