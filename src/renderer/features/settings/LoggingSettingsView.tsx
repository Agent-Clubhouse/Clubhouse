import { useEffect } from 'react';
import { useLoggingStore } from '../../stores/loggingStore';
import type { LogLevel, LogRetention } from '../../../shared/types';
import { LOG_LEVEL_PRIORITY } from '../../../shared/types';

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className={`
        relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer
        ${disabled ? 'opacity-40 cursor-not-allowed' : ''}
        ${checked ? 'bg-indigo-500' : 'bg-surface-2'}
      `}
    >
      <span
        className={`
          absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform duration-200
          ${checked ? 'translate-x-4' : 'translate-x-0'}
        `}
      />
    </button>
  );
}

export function LoggingSettingsView() {
  const { settings, namespaces, logPath, loadSettings, saveSettings } = useLoggingStore();

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  if (!settings) {
    return <div className="p-6 text-ctp-subtext0 text-sm">Loading…</div>;
  }

  const handleNamespaceToggle = (ns: string, value: boolean) => {
    saveSettings({
      namespaces: { ...settings.namespaces, [ns]: value },
    });
  };

  const isNamespaceEnabled = (ns: string): boolean => {
    return settings.namespaces[ns] !== false;
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Logging</h2>

        {/* Privacy banner */}
        <div className="rounded-md bg-surface-0 border border-surface-1 px-4 py-3 mb-5">
          <p className="text-xs text-ctp-subtext1">
            Logs are stored on your local disk only and are never transmitted.
          </p>
        </div>

        <div className="space-y-5">
          {/* Log path */}
          {logPath && (
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm text-ctp-text font-medium">Log Location</div>
                <button
                  type="button"
                  onClick={() => window.clubhouse.file.showInFolder(logPath)}
                  className="text-xs text-ctp-link hover:underline mt-0.5 cursor-pointer"
                >
                  {logPath}
                </button>
              </div>
            </div>
          )}

          {/* Master toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Enable Logging</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">Write structured log entries to disk</div>
            </div>
            <Toggle checked={settings.enabled} onChange={(v) => saveSettings({ enabled: v })} />
          </div>

          {/* Retention tier */}
          <div className="border-t border-surface-0" />
          <div>
            <div className="text-sm text-ctp-text font-medium mb-3">Retention</div>
            <div className="grid grid-cols-2 gap-3">
              {([
                { id: 'low' as LogRetention, label: 'Low', desc: '3 days, up to 50 MB' },
                { id: 'medium' as LogRetention, label: 'Medium', desc: '7 days, up to 200 MB' },
                { id: 'high' as LogRetention, label: 'High', desc: '30 days, up to 500 MB' },
                { id: 'unlimited' as LogRetention, label: 'Unlimited', desc: 'No limits on age or size' },
              ]).map((tier) => {
                const selected = settings.retention === tier.id;
                const disabled = !settings.enabled;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => saveSettings({ retention: tier.id })}
                    className={`
                      rounded-md border px-3 py-2 text-left transition-colors cursor-pointer
                      ${disabled ? 'opacity-40 cursor-not-allowed' : ''}
                      ${selected ? 'border-ctp-accent bg-surface-0' : 'border-surface-1 bg-surface-0/50 hover:border-surface-2'}
                    `}
                  >
                    <div className="text-sm text-ctp-text font-medium">{tier.label}</div>
                    <div className="text-xs text-ctp-subtext0 mt-0.5">{tier.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Minimum log level */}
          <div className="border-t border-surface-0" />
          <div>
            <div className="text-sm text-ctp-text font-medium mb-3">Minimum Level</div>
            <div className="flex gap-2">
              {(Object.keys(LOG_LEVEL_PRIORITY) as LogLevel[]).map((level) => {
                const selected = settings.minLogLevel === level;
                const disabled = !settings.enabled;
                return (
                  <button
                    key={level}
                    type="button"
                    disabled={disabled}
                    onClick={() => saveSettings({ minLogLevel: level })}
                    className={`
                      rounded-md border px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer
                      ${disabled ? 'opacity-40 cursor-not-allowed' : ''}
                      ${selected ? 'border-ctp-accent bg-surface-0 text-ctp-text' : 'border-surface-1 bg-surface-0/50 text-ctp-subtext0 hover:border-surface-2'}
                    `}
                  >
                    {level}
                  </button>
                );
              })}
            </div>
          </div>

          {namespaces.length > 0 && (
            <>
              <div className="border-t border-surface-0" />

              <div>
                <div className="text-sm text-ctp-text font-medium mb-3">Namespaces</div>
                <div className="space-y-3">
                  {namespaces.map((ns) => (
                    <div key={ns} className="flex items-center justify-between py-1">
                      <div className="text-sm text-ctp-subtext1 font-mono">{ns}</div>
                      <Toggle
                        checked={isNamespaceEnabled(ns)}
                        onChange={(v) => handleNamespaceToggle(ns, v)}
                        disabled={!settings.enabled}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
