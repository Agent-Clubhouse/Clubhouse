import { TourLink } from '../stage-parts';
import { Button } from '../../../components/Button';
import { openHelpLink, openSmartRoutingSettings } from '../tour-actions';
import type { SceneDef } from './types';

/** Orchestrators and helpers, for everyone. Smart routing is a second scene only when it has CLIs to choose between. */

function OrchExtra() {
  return (
    <div className="wt-x">
      <TourLink onClick={() => openHelpLink('helpers')}>Orchestrators and helpers, in Help</TourLink>
    </div>
  );
}

export const orch: SceneDef = {
  title: 'Orchestrators split the work across helpers',
  text: 'An orchestrator is an agent that plans a job and starts helpers to do it. A helper is a short-lived agent for one task, in its own workspace on its own branch. It reports back to the orchestrator, which checks the work and deletes the helper once it’s accepted.',
  Extra: OrchExtra,
};

function SmartRoutingExtra() {
  return (
    <div className="wt-x">
      <Button onClick={openSmartRoutingSettings}>Open Settings › Smart routing</Button>
      <span className="wt-muted">Choose the models for each difficulty there.</span>
    </div>
  );
}

export const smartRouting: SceneDef = {
  title: 'Smart routing picks a CLI for each helper',
  text: 'You have more than one CLI signed in. When an orchestrator starts a helper, it says how hard the job is. Smart routing then picks the CLI with the most room left on its plan, and the model you mapped to that difficulty. It skips a plan that’s nearly used up, and each helper keeps what it was given.',
  Extra: SmartRoutingExtra,
};
