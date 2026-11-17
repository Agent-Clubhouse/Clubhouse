import { useId, useLayoutEffect, useRef } from 'react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { AgentRow } from './AgentRow';
import { agentDot } from './treeModel';
import { StatusDot, dispatcherDot, dispatcherWorkingText, type AgentDot } from '../../features/agents/agent-status';
import { useChatStore } from '../../stores/chatStore';
import { activeRunFailing } from '../../features/dispatcher/work-conversation';
import { DISPATCHER_CONTROLLER_NAME, DEFAULT_DISPATCHER_NAME } from '../../../shared/dispatcher-name';
import type { RemoteDispatcherPresence, RemoteDispatcherState } from '../../../shared/dispatcher-presence';
import { AgentAvatar } from '../../features/agents/AgentAvatar';

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
export function DispatcherRow({ agent, detailed, requestsUnderWay = 0, active, projectPath, loadError, onSelect, machine, machineName, offline = false }: {
  agent?: Agent;
  /** Following a lead on another computer (#3352): that computer's short name. */
  machine?: string;
  /** That computer's full alias, for the row's name and hover card (#3607). */
  machineName?: string;
  /** That computer is offline. */
  offline?: boolean;
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
        machine={machine}
        machineName={machineName}
        offline={offline}
      />
    </div>
  );
}

/** Where a Dispatcher row sits: peers at one level, a controller one level under its owner. */
const OWNER_LEVEL = { level: 1, indent: 8 } as const;
const CONTROLLER_LEVEL = { level: 2, indent: 28 } as const;

/**
 * The avatar of a row that has no agent record or icon to draw: the name's
 * first letter in the same 18px circle an agent's initials use.
 */
function FallbackAvatar({ name }: { name: string }) {
  return (
    <span
      data-testid="dispatcher-avatar-fallback"
      aria-hidden="true"
      className="w-[18px] h-[18px] flex-shrink-0 rounded-full flex items-center justify-center bg-surface-2 text-ctp-subtext0 text-[8px] font-bold"
    >
      {Array.from(name.trim())[0]?.toUpperCase() ?? 'D'}
    </span>
  );
}

/**
 * A Dispatcher group row in AgentRow's layout (status dot, avatar, name, a
 * short note) for the ones that have no agent in this computer's store, so no
 * menu or hover card. Without `onSelect` it is a label, not a target.
 */
function GroupRow({ testId, label, name, level, dot, avatar, note, noteClass = 'text-ctp-overlay1', active = false, dimmed = false, onSelect }: {
  testId?: string;
  label: string;
  name: string;
  level: { level: number; indent: number };
  dot: AgentDot;
  avatar: React.ReactNode;
  note?: string;
  noteClass?: string;
  active?: boolean;
  dimmed?: boolean;
  onSelect?: () => void;
}) {
  const noteId = useId();
  return (
    <div
      data-testid={testId}
      data-active={active}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={`relative w-full h-[30px] flex-shrink-0 rounded-md flex items-center transition-colors duration-100 ${onSelect ? 'cursor-pointer' : ''} ${
        active ? 'bg-surface-0 text-ctp-text' : onSelect ? 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text' : 'text-ctp-subtext1'
      }${dimmed ? ' opacity-60' : ''}`}
    >
      <div
        role="treeitem"
        tabIndex={onSelect ? 0 : -1}
        aria-level={level.level}
        aria-selected={active}
        aria-label={label}
        aria-describedby={note ? noteId : undefined}
        onKeyDown={onSelect ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
        } : undefined}
        style={{ paddingLeft: level.indent }}
        className="relative min-w-0 flex-1 h-full pr-1 rounded-md flex items-center gap-2 text-[13px] text-left focus-ring"
      >
        <StatusDot dot={dot} />
        {avatar}
        <span className="truncate font-medium">{name}</span>
        {note && <span id={noteId} className={`ml-auto flex-shrink-0 text-xs ${noteClass}`}>{note}</span>}
      </div>
    </div>
  );
}

/**
 * The row before its agent is in the agent store: the status dot, a fallback
 * avatar, the name and a short note, in AgentRow's layout. Without the agent
 * there's no menu or hover card.
 */
function PendingRow({ failed, active, onSelect }: { failed: boolean; active: boolean; onSelect: () => void }) {
  return (
    <GroupRow
      testId="dispatcher-row-pending"
      label="Dispatcher"
      name="Dispatcher"
      level={OWNER_LEVEL}
      dot={failed ? 'error' : 'starting'}
      avatar={<FallbackAvatar name="Dispatcher" />}
      note={failed ? 'couldn’t load' : 'loading'}
      noteClass={failed ? 'text-ctp-error' : 'text-ctp-overlay1'}
      active={active}
      onSelect={onSelect}
    />
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
  const inTurn = useChatStore((s) => !!s.agents[agentId]?.turnStartedAt);
  // Only the active run's last turn counts (#3242): errors kept from ended runs are history.
  const failing = useChatStore((s) => activeRunFailing(s.agents[agentId]));
  const dot: AgentDot = !running ? 'sleeping' : inTurn ? 'working' : failing ? 'error' : 'idle';
  return (
    <div role="tree" aria-label={`${DISPATCHER_CONTROLLER_NAME} (debug)`} data-testid="dispatcher-work-row" className="flex-shrink-0 px-1.5 pb-1">
      <GroupRow
        label={DISPATCHER_CONTROLLER_NAME}
        name={DISPATCHER_CONTROLLER_NAME}
        level={CONTROLLER_LEVEL}
        dot={dot}
        avatar={<FallbackAvatar name={DISPATCHER_CONTROLLER_NAME} />}
        note="debug"
        active={active}
        onSelect={onSelect}
      />
    </div>
  );
}

/** A remote Dispatcher's published state as a status dot. */
function remoteDot(state: RemoteDispatcherState): AgentDot {
  switch (state) {
    case 'online': return 'idle';
    case 'working': return 'working';
    case 'unknown': return 'starting';
    default: return 'sleeping';
  }
}

const REMOTE_NOTE: Partial<Record<RemoteDispatcherState, string>> = { offline: 'offline', off: 'off' };

/**
 * Another computer's Dispatcher (#3473), a peer of this computer's: the same
 * level, status dot and avatar. Its avatar is the one it published with its
 * chat agent when this computer has that, else a plain fallback. It stays a
 * target while this computer has no chat for it, and opens its status then.
 * Its controller, in the debug view, sits one level under it, as a label:
 * its traffic isn't shown here (#3474).
 */
export function RemoteDispatcherRow({ remote, chat, iconUrl, active, onSelect, showController }: {
  remote: RemoteDispatcherPresence;
  /** Its chat agent under this computer's namespaced id, once its snapshot is here. */
  chat?: Agent;
  /** The icon that snapshot carries for it. */
  iconUrl?: string;
  active: boolean;
  onSelect: () => void;
  showController: boolean;
}) {
  const name = remote.dispatcherName || DEFAULT_DISPATCHER_NAME;
  const dot = remoteDot(remote.state);
  return (
    <div role="tree" aria-label={remote.label} data-testid="remote-dispatcher-group" className="flex-shrink-0 px-1.5 pb-1">
      <GroupRow
        testId="remote-dispatcher-row"
        label={remote.label}
        name={remote.label}
        level={OWNER_LEVEL}
        dot={dot}
        avatar={chat
          ? <span data-testid="remote-dispatcher-avatar" className="flex-shrink-0"><AgentAvatar agent={chat} size="2xs" iconUrl={iconUrl} /></span>
          : <FallbackAvatar name={name} />}
        note={REMOTE_NOTE[remote.state]}
        dimmed={remote.state === 'offline'}
        active={active}
        onSelect={onSelect}
      />
      {showController && remote.address && (
        <GroupRow
          testId="remote-dispatcher-controller"
          label={`${DISPATCHER_CONTROLLER_NAME} (${remote.state})`}
          name={DISPATCHER_CONTROLLER_NAME}
          level={CONTROLLER_LEVEL}
          dot={dot}
          avatar={<FallbackAvatar name={DISPATCHER_CONTROLLER_NAME} />}
          note={remote.state}
          dimmed={remote.state === 'offline'}
        />
      )}
    </div>
  );
}
