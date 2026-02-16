import { useEffect } from 'react';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

export function OrchestratorSettingsView() {
  const { enabled, allOrchestrators, availability, loadSettings, setEnabled, checkAllAvailability } =
    useOrchestratorStore();

  useEffect(() => {
    loadSettings().then(() => checkAllAvailability());
  }, [loadSettings, checkAllAvailability]);

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Orchestrators</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Enable or disable agent backends. Enabled orchestrators appear in project and agent settings.
        </p>

        <div className="space-y-3">
          {allOrchestrators.map((o) => {
            const isEnabled = enabled.includes(o.id);
            const avail = availability[o.id];
            const isOnlyEnabled = isEnabled && enabled.length === 1;
            const notInstalled = avail && !avail.available;
            const toggleDisabled = isOnlyEnabled || !!notInstalled;

            return (
              <div key={o.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
                <div className="flex items-center gap-3">
                  {/* Availability indicator */}
                  <div
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                      avail?.available ? 'bg-green-500' : avail ? 'bg-red-500' : 'bg-ctp-overlay0'
                    }`}
                    title={
                      avail?.available
                        ? 'CLI found'
                        : avail?.error || 'Checking...'
                    }
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-ctp-text">{o.displayName}</span>
                      {o.badge && (
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 shadow-[0_0_6px_rgba(99,102,241,0.3)]">
                          {o.badge}
                        </span>
                      )}
                    </div>
                    {avail && !avail.available && avail.error && (
                      <div className="text-xs text-ctp-subtext0 mt-0.5">{avail.error}</div>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setEnabled(o.id, !isEnabled)}
                  disabled={toggleDisabled}
                  className="toggle-track"
                  data-on={String(isEnabled)}
                  title={notInstalled ? 'CLI not found — install to enable' : isOnlyEnabled ? 'At least one orchestrator must be enabled' : undefined}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
            );
          })}
        </div>

        {allOrchestrators.length === 0 && (
          <p className="text-sm text-ctp-subtext0">No orchestrators registered.</p>
        )}
      </div>
    </div>
  );
}
