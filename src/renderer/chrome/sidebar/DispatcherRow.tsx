import { useId, useLayoutEffect, useRef } from 'react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { AgentRow } from './AgentRow';
import { agentDot } from './treeModel';
import { StatusDot, dispatcherDot, dispatcherWorkingText, type AgentDot } from '../../features/agents/agent-status';
import { useChatStore } from '../../stores/chatStore';
import { activeRunFailing } from '../../features/dispatcher/work-conversation';
import { DISPATCHER_CONTROLLER_NAME } from '../../../shared/dispatcher-name';

/**
 * The Dispatcher's pinned row (#2538), above every project and shown with
 * none: the usual agent row (status dot, name, provider, activity, hover card
 * and menu), with a flat fill while its view is open. Its menu leaves out what
 * doesn't apply to it (useAgentRowActions). The row is a one-item tree of its
 * own, so it has its own tab stop rather than joining the project tree's.
 * Until its agent has loaded (or when loading it failed) the row still shows,
 * with a plain status, and opens the view that shows the error and Retry (#2572).
 * Its status is the chat's, and working while a request the user made is
 * under way (#3220).
 */
export function DispatcherRow({ agent, detailed, requestsUnderWay = 0, active, projectPath, loadError, onSelect }: {
  agent?: Agent;
  detailed?: AgentDetailedStatus;
  /** The user's requests it is still working on. */
  requestsUnderWay?: number;
  active: boolean;
  projectPath?: string;
  loadError?: string | null;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // AgentRow leaves the tab stop to its tree, as ProjectTree sets it.
  useLayoutEffect(() => {
    const item = ref.current?.querySelector<HTMLElement>('[role="treeitem"]');
    if (item) item.tabIndex = 0;
  });
  if (!agent) {
    return (
      <div ref={ref} role="tree" aria-label="Dispatcher" data-testid="dispatcher-row" className="flex-shrink-0 px-1.5 pb-1">
        <PendingRow failed={!!loadError} active={active} onSelect={onSelect} />
      </div>
    );
  }
  const chatDot = agentDot(agent, detailed);
  const dot = dispatcherDot(chatDot, requestsUnderWay);
  // Working only on a request: the hover card says so, never how the work is divided.
  const shownDetailed = dot !== chatDot && detailed
    ? { ...detailed, state: 'working' as const, message: dispatcherWorkingText(requestsUnderWay) }
    : detailed;
  return (
    <div ref={ref} role="tree" aria-label="Dispatcher" data-testid="dispatcher-row" className="flex-shrink-0 px-1.5 pb-1">
      <AgentRow
        agent={agent}
        dot={dot}
        detailed={shownDetailed}
        active={active}
        indent={8}
        projectPath={projectPath}
        onSelect={onSelect}
        level={1}
      />
    </div>
  );
}

/**
 * The row before its agent is in the agent store: the status dot, a blank
 * avatar, the name and a short note, in AgentRow's layout. Without the agent
 * there's no menu or hover card.
 */
function PendingRow({ failed, active, onSelect }: { failed: boolean; active: boolean; onSelect: () => void }) {
  const noteId = useId();
  return (
    <div
      data-testid="dispatcher-row-pending"
      data-active={active}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={`relative w-full h-[30px] flex-shrink-0 rounded-md flex items-center cursor-pointer transition-colors duration-100 ${
        active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
      }`}
    >
      <div
        role="treeitem"
        aria-level={1}
        aria-selected={active}
        aria-label="Dispatcher"
        aria-describedby={noteId}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
        }}
        style={{ paddingLeft: 8 }}
        className="relative min-w-0 flex-1 h-full pr-1 rounded-md flex items-center gap-2 text-[13px] text-left focus-ring"
      >
        <StatusDot dot={failed ? 'error' : 'starting'} />
        <span className="w-[18px] h-[18px] flex-shrink-0 rounded-full bg-surface-1" aria-hidden="true" />
        <span className="truncate font-medium">Dispatcher</span>
        <span id={noteId} className={`ml-auto flex-shrink-0 text-xs ${failed ? 'text-ctp-error' : 'text-ctp-overlay1'}`}>
          {failed ? 'couldn’t load' : 'loading'}
        </span>
      </div>
    </div>
  );
}

/**
 * The Dispatcher debug view's row (#3188), under the Dispatcher's: its
 * controller, which opens that agent's chat read-only in the Dispatcher's view.
 * The agent isn't in the agent store, so the row has no menu or hover card;
 * its dot says whether it is running and in a turn, and whether the active
 * run's last turn failed.
 */
export function DispatcherWorkRow({ agentId, running, active, onSelect }: {
  agentId: string;
  running: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const noteId = useId();
  const inTurn = useChatStore((s) => !!s.agents[agentId]?.turnStartedAt);
  // Only the active run's last turn counts (#3242): errors kept from ended runs are history.
  const failing = useChatStore((s) => activeRunFailing(s.agents[agentId]));
  const dot: AgentDot = !running ? 'sleeping' : inTurn ? 'working' : failing ? 'error' : 'idle';
  return (
    <div role="tree" aria-label={`${DISPATCHER_CONTROLLER_NAME} (debug)`} data-testid="dispatcher-work-row" className="flex-shrink-0 px-1.5 pb-1">
      <div
        data-active={active}
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className={`relative w-full h-[30px] flex-shrink-0 rounded-md flex items-center cursor-pointer transition-colors duration-100 ${
          active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
        }`}
      >
        <div
          role="treeitem"
          tabIndex={0}
          aria-level={1}
          aria-selected={active}
          aria-label={DISPATCHER_CONTROLLER_NAME}
          aria-describedby={noteId}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
          }}
          style={{ paddingLeft: 8 }}
          className="relative min-w-0 flex-1 h-full pr-1 rounded-md flex items-center gap-2 text-[13px] text-left focus-ring"
        >
          <StatusDot dot={dot} />
          <span className="w-[18px] h-[18px] flex-shrink-0 rounded-full bg-surface-1" aria-hidden="true" />
          <span className="truncate font-medium">{DISPATCHER_CONTROLLER_NAME}</span>
          <span id={noteId} className="ml-auto flex-shrink-0 text-xs text-ctp-overlay1">debug</span>
        </div>
      </div>
    </div>
  );
}
