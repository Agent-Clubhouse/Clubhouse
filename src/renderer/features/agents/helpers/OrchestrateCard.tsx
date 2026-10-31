/**
 * The Orchestrate card in Agent details (#2232, decided 18 October): the
 * "Let this agent orchestrate" switch in its header, and the policy beside
 * the chat. The same controls are on the agent's Helpers settings page. Off
 * with helpers opens the keep / dispose / cancel dialog.
 */

import { useId, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import { Toggle } from '../../../components/Toggle';
import { CardNote, CardRow, DetailsCard } from '../details/DetailsCard';
import { CONTROL_LABELS, controlHelp } from './helper-model';
import { maxHelpersCeiling, openHelpersSettings, type OrchestrationState } from './orchestration-hooks';
import { AccessSelect, CROSS_PROJECT_HELP, ControlSelect, CrossProjectToggle, HelperCountInput, accessNote } from './OrchestrationFields';
import { TurnOffOrchestrationDialog } from './TurnOffOrchestrationDialog';

const SELECT_CLASS = 'h-6 max-w-full px-1.5 rounded-md border border-surface-1 bg-ctp-crust text-xs text-ctp-text focus-ring disabled:opacity-50';
const NUMBER_CLASS = 'h-6 w-14 px-1.5 rounded-md border border-surface-1 bg-ctp-crust text-xs text-ctp-text focus-ring disabled:opacity-50';
const LINK_CLASS = 'text-ctp-link hover:underline cursor-pointer focus-ring rounded-sm';

/** The card's one-line answer. */
export function orchestrateSummary(orch: Pick<OrchestrationState, 'policy'>): string {
  const p = orch.policy;
  if (!p) return '';
  if (!p.orchestrate) return 'off';
  return `${CONTROL_LABELS[p.control].toLowerCase()} · up to ${p.maxHelpers}`;
}

export function OrchestrateCard({ agent, projectPath, orch, open, onToggle }: {
  agent: Agent;
  projectPath: string;
  orch: OrchestrationState;
  open: boolean;
  onToggle: () => void;
}) {
  const ids = { access: useId(), control: useId(), count: useId(), crossProject: useId() };
  const [countError, setCountError] = useState<string | null>(null);
  const { policy, access, saving, globalCap } = orch;
  const running = agent.status === 'running';
  const ceiling = maxHelpersCeiling(globalCap);

  return (
    <>
      <DetailsCard
        id="orchestrate"
        title="Orchestrate"
        summary={orchestrateSummary(orch)}
        open={open}
        onToggle={onToggle}
        action={policy ? (
          <Toggle
            checked={policy.orchestrate}
            disabled={saving}
            onChange={(on) => void orch.setOrchestrate(on)}
            aria-label={`Let ${agent.name} orchestrate`}
            data-testid="orchestrate-toggle"
          />
        ) : undefined}
      >
        {!policy ? (
          <CardNote>Couldn’t read this agent’s orchestration settings.</CardNote>
        ) : !policy.orchestrate ? (
          <CardNote>Turn this on to give {agent.name} the tools to start, message and dispose of helper agents.</CardNote>
        ) : (
          <>
            <CardRow label="Helpers get">
              <span className="flex flex-col items-start gap-1">
                <label htmlFor={ids.access} className="sr-only">Helpers get</label>
                <AccessSelect
                  id={ids.access}
                  value={policy.access}
                  access={access}
                  running={running}
                  name={agent.name}
                  disabled={saving}
                  className={SELECT_CLASS}
                  onChange={(value) => void orch.setPolicy({ access: value })}
                  testId="orchestrate-access"
                />
                <span className="text-ctp-overlay1" data-testid="orchestrate-access-note">{accessNote(access, running, agent.name)}</span>
              </span>
            </CardRow>
            <CardRow label="Control">
              <span className="flex flex-col items-start gap-1">
                <label htmlFor={ids.control} className="sr-only">Control</label>
                <ControlSelect
                  id={ids.control}
                  value={policy.control}
                  disabled={saving}
                  className={SELECT_CLASS}
                  onChange={(value) => void orch.setPolicy({ control: value })}
                  testId="orchestrate-control"
                />
                <span className="text-ctp-overlay1">{controlHelp(policy.control, agent.name)}</span>
              </span>
            </CardRow>
            <CardRow label="At once">
              <span className="flex flex-col items-start gap-1">
                <label htmlFor={ids.count} className="sr-only">Helpers at once</label>
                <HelperCountInput
                  id={ids.count}
                  value={policy.maxHelpers}
                  ceiling={ceiling}
                  disabled={saving}
                  className={NUMBER_CLASS}
                  onCommit={(value) => orch.setPolicy({ maxHelpers: value })}
                  onError={setCountError}
                  testId="orchestrate-max-helpers"
                />
                <span className={countError ? 'text-ctp-error' : 'text-ctp-overlay1'} data-testid="orchestrate-max-helpers-note">
                  {countError ?? (
                    <>
                      Up to {ceiling}, your app-wide limit. Change it in{' '}
                      <button type="button" className={LINK_CLASS} onClick={openHelpersSettings} data-testid="orchestrate-open-helpers-settings">
                        Settings → Helpers
                      </button>.
                    </>
                  )}
                </span>
              </span>
            </CardRow>
            <CardRow label="Cross-project helpers">
              <span className="flex flex-col items-start gap-1">
                <CrossProjectToggle
                  id={ids.crossProject}
                  checked={policy.crossProjectHelpers}
                  name={agent.name}
                  disabled={saving}
                  onChange={(on) => void orch.setCrossProjectHelpers(on)}
                  testId="orchestrate-cross-project"
                />
                <span className="text-ctp-overlay1">{CROSS_PROJECT_HELP}</span>
              </span>
            </CardRow>
          </>
        )}
        {orch.note
          ? <CardNote><span data-testid="orchestrate-note">{orch.note}</span></CardNote>
          : policy?.orchestrate && !running && (
            <CardNote><span data-testid="orchestrate-note">The helper tools appear the next time {agent.name} starts.</span></CardNote>
          )}
        {orch.error && <p className="pr-3.5 pl-[33px] pb-1.5 text-xs text-ctp-error" role="alert" data-testid="orchestrate-error">{orch.error}</p>}
      </DetailsCard>
      {orch.turnOff && (
        <TurnOffOrchestrationDialog
          agent={agent}
          projectPath={projectPath}
          helperIds={orch.turnOff.helperIds}
          helperProjects={orch.turnOff.projects}
          onDone={orch.finishTurnOff}
        />
      )}
    </>
  );
}
