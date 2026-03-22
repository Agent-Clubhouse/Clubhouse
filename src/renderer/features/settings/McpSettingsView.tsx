import { useEffect } from 'react';
import { Toggle } from '../../components/Toggle';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';

export function McpSettingsView() {
  const enabled = useMcpSettingsStore((s) => s.enabled);
  const projectDefault = useMcpSettingsStore((s) => s.projectDefault) as boolean | undefined;
  const loaded = useMcpSettingsStore((s) => s.loaded);
  const loadSettings = useMcpSettingsStore((s) => s.loadSettings);
  const saveSettings = useMcpSettingsStore((s) => s.saveSettings);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  if (!loaded) return null;

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Clubhouse MCP</h2>
        <p className="text-sm text-ctp-subtext0 mb-4">
          Enable the Clubhouse MCP bridge server for agent-widget and agent-to-agent interaction.
          When enabled, agents can use tools to control browser widgets, send messages to other agents, and more.
        </p>

        {/* Info banner */}
        <div className="rounded-lg border border-ctp-blue/30 bg-ctp-blue/5 px-4 py-3 mb-6">
          <p className="text-sm text-ctp-blue font-medium mb-1">How it works</p>
          <p className="text-xs text-ctp-subtext1">
            When MCP is enabled, a local bridge server starts automatically. Agents receive
            scoped tool lists based on their bindings — connect agents to browser widgets or
            other agents using the wire controls on the canvas.
          </p>
        </div>

        {/* Global toggle */}
        <div className="space-y-3 mb-6">
          <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Global</h3>
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Enable MCP</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                Start the MCP bridge server globally. When disabled, MCP still activates if Clubhouse Mode is on (fallback).
              </div>
            </div>
            <Toggle
              checked={!!enabled}
              onChange={(value) => saveSettings({ enabled: value })}
            />
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Project Default</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                Whether projects get MCP injected by default. Individual projects can override in their Orchestrators & Agents settings.
              </div>
            </div>
            <Toggle
              checked={projectDefault !== false}
              onChange={(value) => saveSettings({ projectDefault: value })}
              disabled={!enabled}
            />
          </div>
        </div>

        {/* Restart notice */}
        <div className="border-t border-surface-0 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-ctp-text">Restart App</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                Changes take effect for newly spawned agents. Restart to apply globally.
              </div>
            </div>
            <button
              onClick={() => window.clubhouse.app.restart()}
              className="px-4 py-1.5 text-sm rounded bg-surface-0 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
            >
              Restart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
