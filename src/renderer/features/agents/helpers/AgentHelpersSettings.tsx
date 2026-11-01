/**
 * The agent's Helpers settings page (#2232, mockup "Settings"): the same
 * orchestration switches as the Orchestration card beside the chat, for the
 * classic layout and for anyone who looks in Settings first. Each control
 * saves on its own, like the card, so this page never joins the save bar.
 */

import { useId, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import { Toggle } from '../../../components/Toggle';
import { Field, SectionHeading, inputClass, selectClass } from '../agentSettingsUi';
import { controlHelp } from './helper-model';
import { maxHelpersCeiling, useOrchestration } from './orchestration-hooks';
import {
  AccessSelect, CROSS_PROJECT_HELP, ControlSelect, CrossProjectToggle, DISPATCHER_HELP, DispatcherToggle, HelperCountInput, accessNote,
} from './OrchestrationFields';
import { useDispatcherEnabled } from '../../dispatcher/useDispatcherEnabled';
import { TurnOffOrchestrationDialog } from './TurnOffOrchestrationDialog';

export function AgentHelpersSettings({ agent, projectPath }: { agent: Agent; projectPath: string | undefined }) {
  const orch = useOrchestration(projectPath, agent);
  const ids = { toggle: useId(), access: useId(), control: useId(), count: useId(), crossProject: useId(), dispatcher: useId() };
  // Connect to Dispatcher shows while the Dispatcher is turned on, with orchestration on or off (#2578).
  const showDispatcher = useDispatcherEnabled();
  const [countError, setCountError] = useState<string | null>(null);
  const { policy, access, saving } = orch;
  const running = agent.status === 'running';
  const ceiling = maxHelpersCeiling(orch.globalCap);

  if (!projectPath || !policy) {
    return <p className="mt-3 text-[13px] text-ctp-subtext1" data-testid="agent-helpers-settings-unavailable">Couldn’t read {agent.name}’s orchestration settings.</p>;
  }

  return (
    <div data-testid="agent-helpers-settings">
      <SectionHeading title="Orchestrating" />
      <Field
        label="Let this agent orchestrate"
        htmlFor={ids.toggle}
        help="Adds the helper and connection tools to its Clubhouse MCP. Turning it off while it has helpers asks what to do with them."
      >
        <Toggle
          id={ids.toggle}
          checked={policy.orchestrate}
          disabled={saving}
          onChange={(on) => void orch.setOrchestrate(on)}
          aria-label={`Let ${agent.name} orchestrate`}
          data-testid="settings-orchestrate-toggle"
        />
      </Field>
      {orch.note && <p className="py-1.5 text-xs text-ctp-overlay1" data-testid="settings-orchestrate-note">{orch.note}</p>}
      <Field label="Control" htmlFor={ids.control} help={controlHelp(policy.control, agent.name)}>
        <ControlSelect
          id={ids.control}
          value={policy.control}
          disabled={saving || !policy.orchestrate}
          className={selectClass}
          onChange={(value) => void orch.setPolicy({ control: value })}
          testId="settings-orchestrate-control"
        />
      </Field>
      <Field
        label="Helpers at once"
        htmlFor={ids.count}
        help={<span className={countError ? 'text-ctp-error' : undefined}>{countError ?? `Running helpers count against your plan limits. Up to ${ceiling}, the app-wide limit.`}</span>}
      >
        <HelperCountInput
          id={ids.count}
          value={policy.maxHelpers}
          ceiling={ceiling}
          disabled={saving || !policy.orchestrate}
          className={`${inputClass} w-[70px]`}
          onCommit={(value) => orch.setPolicy({ maxHelpers: value })}
          onError={setCountError}
          testId="settings-orchestrate-max-helpers"
        />
      </Field>
      {policy.orchestrate && (
        <Field label="Cross-project helpers" htmlFor={ids.crossProject} help={CROSS_PROJECT_HELP}>
          <CrossProjectToggle
            id={ids.crossProject}
            checked={policy.crossProjectHelpers}
            name={agent.name}
            disabled={saving}
            onChange={(on) => void orch.setCrossProjectHelpers(on)}
            testId="settings-orchestrate-cross-project"
          />
        </Field>
      )}
      {showDispatcher && (
        <Field label="Connect to Dispatcher" htmlFor={ids.dispatcher} help={DISPATCHER_HELP}>
          <DispatcherToggle
            id={ids.dispatcher}
            checked={policy.connectToDispatcher}
            name={agent.name}
            disabled={saving}
            onChange={(on) => void orch.setConnectToDispatcher(on)}
            testId="settings-orchestrate-dispatcher"
          />
        </Field>
      )}

      <SectionHeading title="Defaults for new helpers" />
      <Field
        label="Access"
        htmlFor={ids.access}
        help={`Never more than ${agent.name}. Same as ${agent.name} includes Full access when ${agent.name} has it. ${accessNote(access, running, agent.name)}`}
      >
        <AccessSelect
          id={ids.access}
          value={policy.access}
          access={access}
          running={running}
          name={agent.name}
          disabled={saving || !policy.orchestrate}
          className={selectClass}
          onChange={(value) => void orch.setPolicy({ access: value })}
          testId="settings-orchestrate-access"
        />
      </Field>
      {orch.error && <p className="py-1.5 text-xs text-ctp-error" role="alert" data-testid="settings-orchestrate-error">{orch.error}</p>}

      {orch.turnOff && (
        <TurnOffOrchestrationDialog
          agent={agent}
          projectPath={projectPath}
          helperIds={orch.turnOff.helperIds}
          helperProjects={orch.turnOff.projects}
          onDone={orch.finishTurnOff}
        />
      )}
    </div>
  );
}
