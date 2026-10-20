import { useEffect } from 'react';
import { useLoggingStore } from '../../stores/loggingStore';
import type { LogLevel, LogRetention } from '../../../shared/types';
import { LOG_LEVEL_PRIORITY } from '../../../shared/types';
import { Toggle } from '../../components/Toggle';
import { Spinner } from '../../components/Spinner';
import { TelemetrySettingsSection } from './TelemetrySettingsSection';
import { SettingsPage, SettingsSection, SettingsField } from './SettingsLayout';

const RETENTION_TIERS: { id: LogRetention; label: string; desc: string }[] = [
  { id: 'low', label: 'Low', desc: '3 days, up to 50 MB' },
  { id: 'medium', label: 'Medium', desc: '7 days, up to 200 MB' },
  { id: 'high', label: 'High', desc: '30 days, up to 500 MB' },
  { id: 'unlimited', label: 'Unlimited', desc: 'No limits on age or size' },
];

/** A 28px segmented control, one choice at a time. */
function Segmented<T extends string>({ value, options, onChange, disabled, 'aria-label': ariaLabel, mono }: {
  value: T;
  options: { id: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  'aria-label': string;
  mono?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`flex h-7 p-0.5 gap-0.5 rounded-md border border-surface-1 ${disabled ? 'opacity-40' : ''}`}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.title}
          disabled={disabled}
          onClick={() => onChange(o.id)}
          className={`px-2 rounded text-xs transition-colors focus-ring ${mono ? 'font-mono' : ''} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${
            value === o.id ? 'bg-surface-1 text-ctp-text' : 'text-ctp-overlay1 hover:text-ctp-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LoggingSettingsView() {
  const { settings, namespaces, logPath, loadSettings, saveSettings } = useLoggingStore();

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  if (!settings) {
    return <div className="p-6 flex items-center gap-2 text-ctp-subtext0 text-sm"><Spinner size="sm" /> Loading…</div>;
  }

  const handleNamespaceToggle = (ns: string, value: boolean) => {
    saveSettings({
      namespaces: { ...settings.namespaces, [ns]: value },
    });
  };

  const isNamespaceEnabled = (ns: string): boolean => {
    return settings.namespaces[ns] !== false;
  };

  const retentionTier = RETENTION_TIERS.find((t) => t.id === settings.retention);

  return (
    <SettingsPage title="Logging" description="Logs are stored on your local disk only and are never transmitted.">
      <div className="mt-[22px]">
        {logPath && (
          <SettingsField
            label="Log location"
            help={
              <button
                type="button"
                onClick={() => window.clubhouse.file.showInFolder(logPath)}
                className="text-ctp-link hover:underline cursor-pointer font-mono text-left break-all"
              >
                {logPath}
              </button>
            }
          />
        )}

        <SettingsField label="Write logs" help="Write structured log entries to disk.">
          <Toggle aria-label="Write logs" checked={settings.enabled} onChange={(v) => saveSettings({ enabled: v })} />
        </SettingsField>

        <SettingsField
          label="Record telemetry locally"
          help="Write flow timings, error types and metric totals to telemetry files in the log folder, anonymized the same way as export. Telemetry export, set up below, sends only what this records, so it sends nothing while this is off."
        >
          <Toggle
            aria-label="Record telemetry locally"
            checked={settings.enabled && settings.telemetryRecording !== false}
            onChange={(v) => saveSettings({ telemetryRecording: v })}
            disabled={!settings.enabled}
          />
        </SettingsField>

        <SettingsField
          label="Telemetry detail"
          help="Detailed also records each IPC call and agent tool call. Export never sends more detail than this."
        >
          <Segmented
            aria-label="Telemetry detail"
            value={settings.telemetryLevel === 'detailed' ? 'detailed' : 'standard'}
            options={[
              { id: 'standard', label: 'Standard' },
              { id: 'detailed', label: 'Detailed' },
            ]}
            onChange={(v) => saveSettings({ telemetryLevel: v })}
            disabled={!settings.enabled || settings.telemetryRecording === false}
          />
        </SettingsField>

        <SettingsField label="Retention" help={retentionTier?.desc}>
          <Segmented
            aria-label="Retention"
            value={settings.retention}
            options={RETENTION_TIERS.map((t) => ({ id: t.id, label: t.label, title: t.desc }))}
            onChange={(v) => saveSettings({ retention: v })}
            disabled={!settings.enabled}
          />
        </SettingsField>

        <SettingsField label="Minimum level" help="Entries below this level are not written.">
          <Segmented
            aria-label="Minimum level"
            mono
            value={settings.minLogLevel}
            options={(Object.keys(LOG_LEVEL_PRIORITY) as LogLevel[]).map((level) => ({ id: level, label: level }))}
            onChange={(v) => saveSettings({ minLogLevel: v })}
            disabled={!settings.enabled}
          />
        </SettingsField>
      </div>

      {namespaces.length > 0 && (
        <SettingsSection title="Namespaces">
          {namespaces.map((ns) => (
            <SettingsField key={ns} label={<span className="font-mono text-xs text-ctp-subtext1">{ns}</span>}>
              <Toggle
                aria-label={ns}
                checked={isNamespaceEnabled(ns)}
                onChange={(v) => handleNamespaceToggle(ns, v)}
                disabled={!settings.enabled}
              />
            </SettingsField>
          ))}
        </SettingsSection>
      )}

      <TelemetrySettingsSection />
    </SettingsPage>
  );
}
