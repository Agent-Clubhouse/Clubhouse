import { useEffect } from 'react';
import { useLoggingStore } from '../../stores/loggingStore';
import type { LogLevel, LogRetention } from '../../../shared/types';
import { LOG_LEVEL_PRIORITY, LOG_RETENTION_TIERS } from '../../../shared/types';
import { Toggle } from '../../components/Toggle';
import { Spinner } from '../../components/Spinner';
import { TelemetrySettingsSection } from './TelemetrySettingsSection';
import { SettingsPage, SettingsSection, SettingsField, settingsHelp } from './SettingsLayout';

const RETENTION_LABELS: Record<LogRetention, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  unlimited: 'Unlimited',
};

/** Retention choices, described from the same tiers the cleanup applies. */
const RETENTION_TIERS = (Object.keys(LOG_RETENTION_TIERS) as LogRetention[]).map((id) => {
  const { retentionDays, maxTotalBytes } = LOG_RETENTION_TIERS[id];
  const desc = retentionDays === 0 && maxTotalBytes === 0
    ? 'No limits on age or size'
    : `${retentionDays} days, up to ${Math.round(maxTotalBytes / (1024 * 1024))} MB`;
  return { id, label: RETENTION_LABELS[id], desc };
});

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
    <SettingsPage
      title="Logging"
      description="The diagnostic log and local telemetry are written to files on this computer. Clubhouse never sends the log folder anywhere."
    >
      <div className="mt-[22px]">
        {logPath && (
          <SettingsField
            label="Log folder"
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

        <SettingsField
          label="Record locally"
          help="Write the diagnostic log and local telemetry to the log folder. While this is off nothing is recorded, and telemetry export has nothing to send."
        >
          <Toggle aria-label="Record locally" checked={settings.enabled} onChange={(v) => saveSettings({ enabled: v })} />
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
      </div>

      <SettingsSection title="Diagnostic log">
        <p className={`${settingsHelp} mb-1`} data-testid="diagnostic-log-privacy">
          Diagnostic lines keep file paths, error messages and session ids as written, so they are useful for debugging. They are not anonymized. Clubhouse never sends them.
        </p>
        <SettingsField label="Minimum level" help="Diagnostic lines below this level are not written.">
          <Segmented
            aria-label="Minimum level"
            mono
            value={settings.minLogLevel}
            options={(Object.keys(LOG_LEVEL_PRIORITY) as LogLevel[]).map((level) => ({ id: level, label: level }))}
            onChange={(v) => saveSettings({ minLogLevel: v })}
            disabled={!settings.enabled}
          />
        </SettingsField>
      </SettingsSection>

      {namespaces.length > 0 && (
        <SettingsSection title="Namespaces" meta="Turn one off to stop writing its diagnostic lines.">
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

      <SettingsSection title="Local telemetry">
        <SettingsField
          label="Record telemetry signals"
          help="Write flow timings, error types and metric totals to the log folder. Signals are anonymized the same way as export. Telemetry export, set up below, sends only what this records."
        >
          <Toggle
            aria-label="Record telemetry signals"
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
      </SettingsSection>

      <TelemetrySettingsSection />
    </SettingsPage>
  );
}
