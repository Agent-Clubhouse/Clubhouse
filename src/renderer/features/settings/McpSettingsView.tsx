import { useEffect } from 'react';
import { Toggle } from '../../components/Toggle';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';
import { SettingsPage, SettingsSection, SettingsField } from './SettingsLayout';
import { Button } from '../../components/Button';

export function McpSettingsView() {
  const enabled = useMcpSettingsStore((s) => s.enabled);
  const projectDefault = useMcpSettingsStore((s) => s.projectDefault) as boolean | undefined;
  const loaded = useMcpSettingsStore((s) => s.loaded);
  const loadSettings = useMcpSettingsStore((s) => s.loadSettings);
  const saveSettings = useMcpSettingsStore((s) => s.saveSettings);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  if (!loaded) return null;

  return (
    <SettingsPage
      title="Clubhouse MCP"
      description="A local bridge server that lets agents drive browser widgets and message other agents."
    >
      <p className="text-xs text-ctp-overlay1 mt-3">
        When MCP is on, the bridge starts automatically and each agent gets tools for what it is wired to.
        Wire agents to browser widgets or other agents on the canvas.
      </p>

      <SettingsSection title="Global">
        <SettingsField
          label="MCP bridge"
          help="Start the bridge server for every project. When off, MCP still starts if Clubhouse mode is on."
        >
          <Toggle
            aria-label="MCP bridge"
            checked={!!enabled}
            onChange={(value) => saveSettings({ enabled: value })}
          />
        </SettingsField>
        <SettingsField
          label="Project default"
          help="Whether projects get MCP by default. Each project can override this in Orchestrators & agents."
        >
          <Toggle
            aria-label="Project default"
            checked={projectDefault !== false}
            onChange={(value) => saveSettings({ projectDefault: value })}
            disabled={!enabled}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Apply changes">
        <SettingsField label="Restart Clubhouse" help="Changes apply to agents you start from now on. Restart to apply them everywhere.">
          <Button onClick={() => window.clubhouse.app.restart()} kind="ghost">
            Restart
          </Button>
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}
