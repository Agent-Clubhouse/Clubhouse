import { Button } from '../../components/Button';
import { useUIStore } from '../../stores/uiStore';
import { SettingsBlock, SettingsPage, SettingsSection, settingsHelp } from '../settings/SettingsLayout';

/**
 * Settings, Managed agents, Orchestration (#2899): orchestration is a setting
 * any agent can have, so this page only says where it lives.
 */
export function OrchestrationSettingsView() {
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  return (
    <SettingsPage title="Orchestration" description="Agents that start and run helpers." testId="managed-orchestration">
      <SettingsSection title="Turning it on">
        <SettingsBlock className="flex flex-col gap-2">
          <p className="text-[13px] text-ctp-subtext1">
            Any agent can start helpers. Turn on orchestration in the agent's own settings, on its Helpers page, and set how many helpers it may run.
          </p>
          <p className={settingsHelp}>Templates can turn it on for the agents made from them.</p>
        </SettingsBlock>
      </SettingsSection>
      <SettingsSection title="Helpers">
        <SettingsBlock className="flex items-center gap-3">
          <p className={`${settingsHelp} flex-1 min-w-0`}>The limit across every orchestrator and the default helper template are on the Helpers page. Auto and the difficulty presets are on Smart selection.</p>
          <Button onClick={() => setSettingsSubPage('helpers')} data-testid="managed-orchestration-open-helpers">Open Helpers</Button>
          <Button onClick={() => setSettingsSubPage('smart-selection')} data-testid="managed-orchestration-open-smart-selection">Open Smart selection</Button>
        </SettingsBlock>
      </SettingsSection>
    </SettingsPage>
  );
}
