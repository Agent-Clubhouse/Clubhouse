import { useEffect, useMemo } from 'react';
import { Toggle } from '../../components/Toggle';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';
import { useProjectStore } from '../../stores/projectStore';

export function McpSettingsView() {
  const enabled = useMcpSettingsStore((s) => s.enabled);
  const projectOverrides = useMcpSettingsStore((s) => s.projectOverrides);
  const loaded = useMcpSettingsStore((s) => s.loaded);
  const loadSettings = useMcpSettingsStore((s) => s.loadSettings);
  const saveSettings = useMcpSettingsStore((s) => s.saveSettings);
  const projects = useProjectStore((s) => s.projects);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const overrides = useMemo(() => projectOverrides ?? {}, [projectOverrides]);

  const handleGlobalToggle = (value: boolean) => {
    saveSettings({ enabled: value });
  };

  const handleProjectToggle = (projectPath: string, value: boolean) => {
    saveSettings({ projectOverrides: { ...overrides, [projectPath]: value } });
  };

  const handleClearOverride = (projectPath: string) => {
    const { [projectPath]: _, ...rest } = overrides;
    saveSettings({ projectOverrides: Object.keys(rest).length > 0 ? rest : undefined });
  };

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
                Enable the MCP bridge globally. Per-project overrides take precedence.
                When disabled, MCP still activates if Clubhouse Mode is on (fallback).
              </div>
            </div>
            <Toggle
              checked={enabled}
              onChange={handleGlobalToggle}
            />
          </div>
        </div>

        {/* Per-project overrides */}
        {projects.length > 0 && (
          <div className="space-y-3 mb-6">
            <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Per-Project Overrides</h3>
            <p className="text-xs text-ctp-subtext0">
              Override the global setting for specific projects. "Default" inherits the global value.
            </p>
            {projects.map((project) => {
              const override = overrides[project.path];
              const hasOverride = override !== undefined;
              return (
                <div key={project.id} className="flex items-center justify-between py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-ctp-text font-medium truncate">{project.name}</div>
                    <div className="text-xs text-ctp-subtext0 mt-0.5 truncate">{project.path}</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    {hasOverride ? (
                      <>
                        <Toggle
                          checked={override}
                          onChange={(value) => handleProjectToggle(project.path, value)}
                        />
                        <button
                          className="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors"
                          onClick={() => handleClearOverride(project.path)}
                        >
                          Reset
                        </button>
                      </>
                    ) : (
                      <button
                        className="text-xs text-ctp-subtext0 hover:text-ctp-text bg-surface-0 rounded px-2 py-1 transition-colors"
                        onClick={() => handleProjectToggle(project.path, !enabled)}
                      >
                        Override
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

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
              className="px-4 py-1.5 text-sm rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 transition-colors cursor-pointer"
            >
              Restart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
