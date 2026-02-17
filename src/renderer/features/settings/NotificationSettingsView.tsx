import { useEffect } from 'react';
import { useNotificationStore } from '../../stores/notificationStore';
import { useBadgeStore } from '../../stores/badgeStore';

const TOGGLES: { key: keyof Omit<import('../../../shared/types').NotificationSettings, 'enabled' | 'playSound'>; label: string; description: string }[] = [
  { key: 'permissionNeeded', label: 'Permission Needed', description: 'Notify when an agent is waiting for approval' },
  { key: 'agentStopped', label: 'Agent Stopped', description: 'Notify when an agent has finished running' },
  { key: 'agentIdle', label: 'Agent Idle', description: 'Notify when an agent is waiting for input' },
  { key: 'agentError', label: 'Agent Error', description: 'Notify when a tool call fails' },
];

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

export function NotificationSettingsView() {
  const { settings, loadSettings, saveSettings } = useNotificationStore();

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  if (!settings) {
    return <div className="p-6 text-ctp-subtext0 text-sm">Loading…</div>;
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Notifications</h2>

        <div className="space-y-5">
          {/* Master toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Enable Notifications</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">Show macOS notifications for agent events</div>
            </div>
            <Toggle checked={settings.enabled} onChange={(v) => saveSettings({ enabled: v })} />
          </div>

          <div className="border-t border-surface-0" />

          {/* Event toggles */}
          {TOGGLES.map(({ key, label, description }) => (
            <div key={key} className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm text-ctp-text font-medium">{label}</div>
                <div className="text-xs text-ctp-subtext0 mt-0.5">{description}</div>
              </div>
              <Toggle
                checked={settings[key]}
                onChange={(v) => saveSettings({ [key]: v })}
                disabled={!settings.enabled}
              />
            </div>
          ))}

          <div className="border-t border-surface-0" />

          {/* Sound toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Play Sound</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">Play the default notification sound</div>
            </div>
            <Toggle
              checked={settings.playSound}
              onChange={(v) => saveSettings({ playSound: v })}
              disabled={!settings.enabled}
            />
          </div>

          <div className="border-t border-surface-0" />

          {/* Test notification */}
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Test Notification</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">Send a test notification (also triggers the macOS permission prompt)</div>
            </div>
            <button
              type="button"
              onClick={() => window.clubhouse.app.sendNotification('Clubhouse', 'Notifications are working!', !settings.playSound)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
            >
              Send Test
            </button>
          </div>

          <div className="border-t border-surface-0" />

          {/* Clear all badges */}
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Clear All Badges</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">Remove all badge indicators from tabs, projects, and the dock</div>
            </div>
            <button
              type="button"
              onClick={() => useBadgeStore.getState().clearAll()}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
            >
              Clear All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
