import type { HelperDifficulty, HelperRouting } from '../../../shared/helper-routing';
import type { ActionOwner } from '../../../shared/actions';
import { getDurableConfig } from '../agent-config';
import { getOrchestrationPolicy } from '../orchestration-policy';
import { commitAutoDecision, settleAutoDecision } from '../helper-auto-state';
import { autoOffRefusal, decideAutoPlan, planHelperStart, readHelperAuto } from '../helper-routing';
import { startQuickAgent, type StartQuickAgentParams } from '../quick-agent-service';
import { onAgentExit } from '../agent-exit-broadcast';
import { isAgentRunning } from '../agent-system';

/** Explicit and older steps keep the ordinary quick-agent start path. */
export async function startActionQuickAgent(req: StartQuickAgentParams & { owner: ActionOwner; difficulty?: HelperDifficulty }): Promise<{ id: string; name: string; routing?: HelperRouting }> {
  if (req.orchestrator !== 'auto') return startQuickAgent(req);
  const autoState = async () => {
    const projectPath = req.project.path;
    if (req.owner.kind !== 'agent') return readHelperAuto({ projectPath, ...(req.owner.kind === 'dispatcher' && { dispatcher: true }) });
    const [config, policy] = await Promise.all([
      getDurableConfig(projectPath, req.owner.agentId),
      getOrchestrationPolicy(projectPath, req.owner.agentId),
    ]);
    if (!config || !policy) throw new Error('The action owner is no longer available.');
    return readHelperAuto({ projectPath, agent: { config, policy } });
  };
  const prepared = await planHelperStart({
    cli: 'auto',
    difficulty: req.difficulty ?? 'medium',
    projectPath: req.project.path,
    auto: await autoState(),
  });
  if (prepared.ok === false) throw new Error(prepared.message);
  if (!prepared.plan) throw new Error('Auto did not prepare a provider choice.');
  const pending = prepared.plan;
  const { currentHelperLoad, withStartLock } = await import('../clubhouse-mcp/tools/helper-tools');
  return withStartLock(async () => {
    const auto = await autoState();
    if (!auto.effective) {
      const refusal = autoOffRefusal(auto);
      if (refusal.ok === false) throw new Error(refusal.message);
    }
    const decided = decideAutoPlan(pending, await currentHelperLoad(req.project.path));
    if (decided.ok === false) throw new Error(decided.message);
    const plan = decided.plan;
    if (!plan?.provider || !plan.decision) throw new Error('Auto did not choose a provider.');
    const decisionId = plan.decision.decisionId;
    try {
      const started = await startQuickAgent({
        ...req,
        orchestrator: plan.provider,
        model: plan.model,
        effort: plan.effort,
      });
      commitAutoDecision(decisionId, started.id);
      const off = onAgentExit((agentId) => {
        if (agentId !== started.id) return;
        off();
        settleAutoDecision(decisionId, 'left_asleep');
      });
      // Unlike helpers, quick agents have no durable row to reconcile after exit.
      if (isAgentRunning(started.id)) settleAutoDecision(decisionId, 'started');
      else {
        off();
        settleAutoDecision(decisionId, 'left_asleep');
      }
      return { id: started.id, name: started.name, routing: plan.routing };
    } catch (err) {
      settleAutoDecision(decisionId, 'spawn_failed');
      throw err;
    }
  });
}
