import { useEffect } from 'react';
import { Toggle } from '../../components/Toggle';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';
import { SettingsPage, SettingsSection, SettingsField } from './SettingsLayout';
import { Button } from '../../components/Button';
import { useMcpOffConfirm } from './McpOffConfirm';

export function McpSettingsView() {
  const enabled = useMcpSettingsStore((s) => s.enabled);
  const loaded = useMcpSettingsStore((s) => s.loaded);
  const loadSettings = useMcpSettingsStore((s) => s.loadSettings);
  const saveSettings = useMcpSettingsStore((s) => s.saveSettings);
  const { requestMcpChange, mcpOffDialog } = useMcpOffConfirm();

  useEffect(() => { loadSettings(); }, [loadSettings]);

  if (!loaded) return null;

  const change = (value: boolean) => {
    const apply = () => saveSettings({ enabled: value });
    if (value) void apply();
    else void requestMcpChange({ proposal: { mcp: { enabled: false } }, always: true, apply, saved: () => useMcpSettingsStore.getState().enabled === false });
  };

  return (
    <SettingsPage
      title="Clubhouse MCP"
      description="A local bridge server that lets agents drive browser widgets and message other agents."
    >
      <p className="text-xs text-ctp-overlay1 mt-3">
        When MCP is on, each agent gets tools for what it is wired to.
        Wire agents to browser widgets or other agents on the canvas.
      </p>

      <SettingsSection title="Global">
        <SettingsField
          label="MCP bridge"
          help={(
            <>
              Helpers, orchestration and the Dispatcher need this. A project or agent can have its own setting.
              Turning it off keeps your saved settings. Turning it back on restores them and doesn’t start any session.
            </>
          )}
        >
          <Toggle
            aria-label="MCP bridge"
            checked={!!enabled}
            onChange={change}
          />
        </SettingsField>
      </SettingsSection>
      {mcpOffDialog}

      <SettingsSection title="Apply changes">
        <SettingsField
          label="Restart Clubhouse"
          help="Turning MCP off stops new Clubhouse tool calls at once, for agents without a setting of their own. Running agents keep running, and helpers can still report to their parent. Turning it on applies at once to agents that started with MCP. An agent that started without it needs a restart to get it. The bridge server keeps running until you restart Clubhouse."
        >
          <Button onClick={() => window.clubhouse.app.restart()} kind="ghost">
            Restart
          </Button>
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}
