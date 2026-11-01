/**
 * The Orchestration and Helpers cards (#2232) as one unit, for Agent details
 * beside a running agent and for the sleeping view. A sleeping orchestrator
 * has no details column, so its view shows the same two cards under the wake
 * composer: pending starts wait there with Approve off until it's awake, and
 * Decline still works.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { isDispatcherAgent } from '../../dispatcher/dispatcherStore';
import { useAgentDetailsStore } from '../details/detailsStore';
import { SectionHead } from '../states/parts';
import { OrchestrateCard } from './OrchestrateCard';
import { HelpersCard } from './HelpersCard';
import { splitHelpers } from './helper-model';
import { useHelperStartApprovals, useOrchestration, useProjectAgentConfigs } from './orchestration-hooks';
import { useHelpersEverywhere } from './cross-project';

/** What the orchestration cards need, and whether each one shows. */
export function useOrchestrationCards(agent: Agent, projectPath: string | undefined) {
  // Local durable agents only; a satellite keeps its own config. The
  // Dispatcher's orchestration settings are locked (#2533), so it has none.
  const orchestrationPath = agent.kind === 'durable' && !isRemoteProjectId(agent.projectId) && !isDispatcherAgent(agent) ? projectPath : undefined;
  const orch = useOrchestration(orchestrationPath, agent);
  const { configs, reload: reloadConfigs } = useProjectAgentConfigs(orchestrationPath, agent.projectId);
  const ownConfig = configs?.find((c) => c.id === agent.id);
  const isHelper = !!(ownConfig?.parentAgentId ?? agent.parentAgentId);
  // Helpers can be in any project (#2514), so the card lists them from main's index, not this project's configs.
  const { helpers: everywhere, reload: reloadHelpers } = useHelpersEverywhere(orchestrationPath, agent.id);
  const helpers = useMemo(() => (everywhere ? splitHelpers(everywhere, agent.id) : { live: [], disposed: [] }), [everywhere, agent.id]);
  const helperIds = useMemo(() => new Set(helpers.live.map((h) => h.config.id)), [helpers.live]);
  const orchestrating = !!orch.policy?.orchestrate;
  const reloadAll = useCallback(() => { reloadConfigs(); reloadHelpers(); }, [reloadConfigs, reloadHelpers]);
  const approvals = useHelperStartApprovals(agent.id, orchestrationPath, reloadAll);
  const showOrchestrate = !!orchestrationPath && !!orch.policy && !!ownConfig && !isHelper;
  const showHelpers = !!orchestrationPath
    && (orchestrating || helpers.live.length > 0 || helpers.disposed.length > 0 || approvals.pending.length > 0);
  return {
    orchestrationPath, orch, configs, reloadConfigs: reloadAll, ownConfig, isHelper, helpers, everywhere, helperIds,
    orchestrating, approvals, showOrchestrate, showHelpers,
  };
}

export type OrchestrationCardsModel = ReturnType<typeof useOrchestrationCards>;

/** The Orchestration card, then the Helpers card, each when it applies. */
export function OrchestrationCardPair({ agent, model, isOpen, onToggle }: {
  agent: Agent;
  model: OrchestrationCardsModel;
  isOpen: (card: 'orchestrate' | 'helpers') => boolean;
  onToggle: (card: 'orchestrate' | 'helpers') => void;
}) {
  const { orchestrationPath, orch, everywhere, orchestrating, approvals, reloadConfigs, showOrchestrate, showHelpers } = model;
  if (!orchestrationPath) return null;
  return (
    <>
      {showOrchestrate && (
        <OrchestrateCard agent={agent} projectPath={orchestrationPath} orch={orch} open={isOpen('orchestrate')} onToggle={() => onToggle('orchestrate')} />
      )}
      {showHelpers && everywhere && (
        <HelpersCard
          agent={agent}
          projectPath={orchestrationPath}
          helpers={everywhere}
          maxHelpers={orch.policy?.maxHelpers}
          orchestrating={orchestrating}
          open={isOpen('helpers')}
          onToggle={() => onToggle('helpers')}
          approvals={approvals}
          onRemoved={reloadConfigs}
        />
      )}
    </>
  );
}

/**
 * The cards on a sleeping orchestrator's view: shown once it orchestrates,
 * has helpers or has starts waiting, and kept for the rest of the visit so
 * turning orchestration off doesn't pull the card from under the pointer.
 * The Helpers card opens on its own while starts wait, and when Needs you
 * asks for it.
 */
export function SleepingOrchestration({ agent, projectPath }: { agent: Agent; projectPath: string | undefined }) {
  const model = useOrchestrationCards(agent, projectPath);
  const waiting = model.approvals.pending.length > 0;
  const relevant = model.orchestrating || model.helpers.live.length > 0 || waiting;
  const [shownFor, setShownFor] = useState<string | null>(null);
  useEffect(() => { if (relevant) setShownFor(agent.id); }, [relevant, agent.id]);
  const shown = relevant || shownFor === agent.id;

  const [open, setOpen] = useState<Set<'orchestrate' | 'helpers'>>(() => new Set());
  useEffect(() => { setOpen(new Set()); }, [agent.id]);
  // A start waiting on the user opens the Helpers card, once per agent.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!waiting || autoOpened.current === agent.id) return;
    autoOpened.current = agent.id;
    setOpen((s) => new Set(s).add('helpers'));
  }, [waiting, agent.id]);
  // "Open in details" (a Needs you entry) opens the card here too.
  const focus = useAgentDetailsStore((s) => s.focus);
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || focus.agentId !== agent.id || handled.current === focus.nonce) return;
    handled.current = focus.nonce;
    if (focus.card === 'orchestrate' || focus.card === 'helpers') setOpen((s) => new Set(s).add(focus.card as 'orchestrate' | 'helpers'));
  }, [focus, agent.id]);

  if (!shown || !model.orchestrationPath || (!model.showOrchestrate && !model.showHelpers)) return null;
  return (
    <section className="w-full mt-[30px] text-left flex flex-col gap-2" aria-label={`${agent.name} orchestration`} data-testid="sleeping-orchestration">
      <SectionHead title="Orchestration" />
      <OrchestrationCardPair
        agent={agent}
        model={model}
        isOpen={(card) => open.has(card)}
        onToggle={(card) => setOpen((s) => {
          const next = new Set(s);
          if (next.has(card)) next.delete(card); else next.add(card);
          return next;
        })}
      />
    </section>
  );
}
