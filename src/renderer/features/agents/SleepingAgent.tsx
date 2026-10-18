import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ATTR, tel } from '../../telemetry';
import { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { isRemoteAgentId, parseNamespacedId } from '../../stores/remoteProjectStore';
import { PopupMenu, type MenuEntry } from '../../components/PopupMenu';
import { Button } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { SleepingMascot } from './SleepingMascots';
import { SessionPickerDialog } from './SessionPickerDialog';
import { SessionNamePromptDialog } from './SessionNamePromptDialog';
import { AgentContextMenu, OverflowIcon, useAgentRowActions } from './useAgentRowActions';
import { pickGreeting } from './states/greetings';
import { Markdown } from './chat/MessageBlocks';
import { useLastSession, type LastSessionInfo } from './states/useLastSession';
import { formatAgo, formatShortDuration, formatUsd, plural, relativeTo } from './states/format';
import {
  BranchIcon, FileRow, Kbd, ModelLabel, SectionHead, StateToolbar, ToolbarSeparator,
} from './states/parts';

/** Below either size the view drops the last session and shrinks the mascot (canvas cards, small popouts). */
const COMPACT_WIDTH = 460;
const COMPACT_HEIGHT = 440;
const FILES_SHOWN = 3;

type WakeMode = 'resume' | 'fresh';

function useCompact(ref: React.RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      // jsdom and hidden panes report 0: treat as full size
      setCompact(width > 0 && height > 0 && (width < COMPACT_WIDTH || height < COMPACT_HEIGHT));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return compact;
}

function cliName(orchestrator?: string): string {
  if (orchestrator === 'codex-cli') return 'codex';
  if (orchestrator === 'copilot-cli') return 'copilot';
  return orchestrator && orchestrator !== 'claude-code' ? orchestrator : 'claude';
}

/**
 * A sleeping (or failed-to-launch) agent, treated as an empty chat (#2019): a
 * greeting that changes with the time of day, a composer to wake the agent
 * with a task, and the last session underneath so you remember where it left off.
 */
export function SleepingAgent({ agent }: { agent: Agent }) {
  const spawnDurableAgent = useAgentStore((s) => s.spawnDurableAgent);
  const sessionNamePromptFor = useAgentStore((s) => s.sessionNamePromptFor);
  const setSessionNamePrompt = useAgentStore((s) => s.setSessionNamePrompt);
  const openAgentSettings = useAgentStore((s) => s.openAgentSettings);
  const storeIconUrl = useAgentStore((s) => s.agentIcons[agent.id]);
  const projects = useProjectStore((s) => s.projects);
  const isRemote = isRemoteAgentId(agent.id);
  const remoteParts = useMemo(() => isRemote ? parseNamespacedId(agent.id) : null, [agent.id, isRemote]);
  // Use the agent's own project, not the globally-active project
  const agentProject = projects.find((p) => p.id === agent.projectId);
  const isDurable = agent.kind === 'durable';
  const failed = agent.status === 'error';

  const rootRef = useRef<HTMLDivElement>(null);
  const compact = useCompact(rootRef);
  const [task, setTask] = useState('');
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  // Synchronous guard: state updates land too late to stop a double click
  const wakingRef = useRef(false);
  const [wakeMenu, setWakeMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const rowActions = useAgentRowActions(agent);

  const last = useLastSession(agent, agentProject?.path, isDurable && !isRemote);
  const hasLastSession = !!last?.sessionId;

  // One greeting per visit to this agent, picked once when the visit starts
  const [greeting, setGreeting] = useState('');
  useEffect(() => { setGreeting(pickGreeting(agent.name, new Date().getHours())); }, [agent.id, agent.name]);

  // Wake resumes the last session when there is one (#2019), so it waits until
  // that's known rather than starting a fresh session by mistake.
  const ready = isRemote || !agentProject || last !== null;

  const wake = useCallback(async (mode: WakeMode, sessionId?: string) => {
    if (wakingRef.current) return;
    const mission = task.trim() || undefined;
    setWakeMenu(null);
    setWakeError(null);
    if (!isRemote && !agentProject) return;
    wakingRef.current = true;
    setWaking(true);
    try {
      if (isRemote && remoteParts) {
        await window.clubhouse.annexClient.agentWake(remoteParts.satelliteId, remoteParts.agentId, { resume: mode === 'resume', mission });
      } else if (agentProject) {
        const configs = await window.clubhouse.agent.listDurable(agentProject.path);
        const config = Array.isArray(configs) ? configs.find((c: { id: string }) => c.id === agent.id) : undefined;
        if (!config) {
          setWakeError(`Couldn't find ${agent.name}'s settings in this project. Reopen the project and try again.`);
          return;
        }
        const effective = sessionId ? { ...config, lastSessionId: sessionId } : config;
        const resume = mode === 'resume' && !!effective.lastSessionId;
        await spawnDurableAgent(agentProject.id, agentProject.path, effective, resume, mission);
      }
      // Only clear the task once the wake went through
      setTask('');
    } catch (err) {
      tel.event('clubhouse.ui.action_failed', [ATTR.uiAction('agent_wake'), ATTR.errorType('unknown')]);
      tel.exception(err, { handled: true, attrs: [ATTR.uiAction('agent_wake')] });
      setWakeError(`Couldn't wake ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      wakingRef.current = false;
      setWaking(false);
    }
  }, [task, isRemote, remoteParts, agentProject, agent.id, agent.name, spawnDurableAgent]);

  // Wake picks up the last session when there is one (#2019).
  // A satellite says whether it has a session; older ones don't, and start fresh.
  const canResume = hasLastSession || (isRemote && agent.hasSession === true);
  const defaultMode: WakeMode = canResume ? 'resume' : 'fresh';

  const wakeItems: MenuEntry[] = [
    { id: 'resume', label: 'Wake and resume last session', disabled: !canResume, selected: defaultMode === 'resume', onSelect: () => { void wake('resume'); } },
    { id: 'fresh', label: 'Wake with a fresh session', selected: defaultMode === 'fresh', onSelect: () => { void wake('fresh'); } },
    ...(!isRemote && agentProject ? [
      { id: 'sep', separator: true as const },
      { id: 'browse', label: 'Browse sessions…', onSelect: () => setSessionPickerOpen(true) },
    ] : []),
  ];

  const handleResumeSession = useCallback((sessionId: string) => {
    setSessionPickerOpen(false);
    void wake('resume', sessionId);
  }, [wake]);

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (ready) void wake(defaultMode);
    }
  };

  // Close the wake menu if the agent wakes some other way
  useEffect(() => { if (agent.status !== 'sleeping' && agent.status !== 'error') setWakeMenu(null); }, [agent.status]);

  const hasOwnIcon = !!agent.emoji || (!!agent.icon && !!storeIconUrl);
  const mascotSize = compact ? 56 : 88;
  const shortcut = window.clubhouse?.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter';

  const headline = failed ? `${agent.name} couldn't start` : isDurable ? greeting : 'Session ended';
  const subline = failed ? (
    <>
      <span className="font-mono text-xs text-ctp-subtext1" data-testid="launch-error">
        {agent.errorMessage || `${cliName(agent.orchestrator)} exited before it started.`}
      </span>{' '}
      Check that the CLI is installed and signed in, then retry.
    </>
  ) : isDurable ? (
    `${agent.name} is sleeping. Give it a task to wake up with, or press Wake to pick up where it left off.`
  ) : (
    `${agent.name} has finished.`
  );

  const toolbarDetail = failed
    ? 'failed to launch'
    : last?.lastActiveAt ? `last active ${formatAgo(last.lastActiveAt)}` : undefined;

  return (
    <div ref={rootRef} className="flex flex-col h-full bg-ctp-base" data-testid="sleeping-agent">
      <StateToolbar
        status={failed ? 'error' : 'sleeping'}
        detail={toolbarDetail}
        testId="sleeping-toolbar"
        right={(
          <>
            <ModelLabel orchestrator={agent.orchestrator} model={agent.model} />
            {isDurable && !isRemote && agentProject && (
              <>
                <ToolbarSeparator />
                <Button kind="quiet" onClick={() => setSessionPickerOpen(true)} data-testid="sessions-button">
                  Sessions
                </Button>
              </>
            )}
            {rowActions.length > 0 && (
              <Tooltip content="More actions">
                <Button
                  kind="quiet"
                  icon={<OverflowIcon />}
                  aria-label={`More actions for ${agent.name}`}
                  aria-haspopup="menu"
                  aria-expanded={moreMenu !== null}
                  data-testid="sleeping-more"
                  className={moreMenu ? 'bg-surface-0 text-ctp-text' : ''}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMoreMenu(moreMenu ? null : { x: r.right - 180, y: r.bottom + 4 });
                  }}
                />
              </Tooltip>
            )}
          </>
        )}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div
          className="mx-auto w-full max-w-[652px] px-4 pb-8 flex flex-col items-center text-center"
          style={{ paddingTop: compact ? 24 : 'clamp(32px, 11vh, 92px)' }}
        >
          {hasOwnIcon ? (
            <AgentIconTile agent={agent} iconUrl={storeIconUrl} size={compact ? 40 : 56} />
          ) : (
            <SleepingMascot orchestrator={agent.orchestrator} size={mascotSize} error={failed} />
          )}

          <h1 className="mt-2.5 text-xl font-semibold text-ctp-text" data-testid="sleeping-greeting">{headline}</h1>
          <p className="mt-1.5 max-w-[520px] text-[12.5px] leading-normal text-ctp-overlay1">{subline}</p>

          {isDurable && (
            <div
              className={`relative w-full ${hasOwnIcon && !compact ? 'mt-[46px]' : 'mt-[22px]'} rounded-lg border border-surface-1 bg-ctp-mantle text-left focus-within:border-surface-2`}
              data-testid="wake-composer"
            >
              {hasOwnIcon && !compact && (
                <span className="absolute right-4 -top-[41px] pointer-events-none">
                  <SleepingMascot orchestrator={agent.orchestrator} size={48} error={failed} />
                </span>
              )}
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={onComposerKey}
                rows={2}
                aria-label={`Task for ${agent.name}`}
                placeholder={failed ? 'Retry with a task, or leave this empty to retry the last session' : `Describe a task for ${agent.name}`}
                data-testid="wake-task-input"
                className="block w-full min-h-[58px] max-h-48 resize-none bg-transparent px-3.5 pt-3 text-[13px] leading-normal text-ctp-text placeholder:text-ctp-overlay0 outline-none"
              />
              <div className="h-[42px] flex items-center gap-1.5 pl-3.5 pr-2">
                <ModelLabel orchestrator={agent.orchestrator} model={agent.model} />
                <span className="ml-auto flex items-center"><Kbd>{shortcut}</Kbd></span>
                {failed && !isRemote && (
                  <Button kind="ghost" onClick={() => openAgentSettings(agent.id)} data-testid="open-settings-button">
                    Open settings
                  </Button>
                )}
                <span className="inline-flex flex-shrink-0">
                  <Button
                    kind="primary"
                    onClick={() => { void wake(defaultMode); }}
                    disabled={waking || !ready}
                    data-testid="wake-button"
                    className="rounded-r-none"
                  >
                    {failed ? 'Retry' : 'Wake'}
                  </Button>
                  <Button
                    kind="primary"
                    aria-label="More ways to wake"
                    aria-haspopup="menu"
                    aria-expanded={wakeMenu !== null}
                    disabled={waking}
                    data-testid="wake-dropdown-toggle"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setWakeMenu(wakeMenu ? null : { x: r.right - 240, y: r.bottom + 4 });
                    }}
                    className="rounded-l-none border-l-ctp-base"
                    icon={(
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    )}
                  />
                </span>
              </div>
            </div>
          )}

          {wakeError && (
            <p role="alert" className="w-full mt-2 text-left text-xs text-ctp-error" data-testid="wake-error">{wakeError}</p>
          )}

          {!compact && last && (last.summary || last.filesModified.length > 0 || agent.branch) && (
            <LastSession
              info={last}
              branch={agent.branch}
              baseDir={agent.worktreePath || agentProject?.path}
              onBrowse={agentProject ? () => setSessionPickerOpen(true) : undefined}
            />
          )}
        </div>
      </div>

      {wakeMenu && (
        <PopupMenu items={wakeItems} position={wakeMenu} label="Wake options" testId="wake-dropdown-menu" minWidth={240} onClose={() => setWakeMenu(null)} />
      )}
      {moreMenu && <AgentContextMenu actions={rowActions} position={moreMenu} onClose={() => setMoreMenu(null)} />}

      {sessionPickerOpen && agentProject && (
        <SessionPickerDialog
          agentId={agent.id}
          projectPath={agentProject.path}
          orchestrator={agent.orchestrator}
          onResume={handleResumeSession}
          onClose={() => setSessionPickerOpen(false)}
        />
      )}

      {/* Session name prompt dialog (shown after agent stops if setting enabled) */}
      {sessionNamePromptFor === agent.id && agentProject && (
        <SessionNamePromptDialog
          agentId={agent.id}
          projectPath={agentProject.path}
          onDone={() => setSessionNamePrompt(null)}
        />
      )}
    </div>
  );
}

/** The agent's own icon or emoji, which leads when set. */
function AgentIconTile({ agent, iconUrl, size }: { agent: Agent; iconUrl?: string; size: number }) {
  const radius = Math.round(size * 0.22);
  if (agent.emoji) {
    return (
      <span className="grid place-items-center bg-surface-0" style={{ width: size, height: size, borderRadius: radius, fontSize: size * 0.55 }} role="img" aria-label={agent.name} data-testid="agent-icon-hero">
        {agent.emoji}
      </span>
    );
  }
  return (
    <img src={iconUrl} alt={agent.name} draggable={false} className="object-cover" style={{ width: size, height: size, borderRadius: radius }} data-testid="agent-icon-hero" />
  );
}

function LastSession({ info, branch, baseDir, onBrowse }: {
  info: LastSessionInfo;
  branch?: string;
  baseDir?: string;
  onBrowse?: () => void;
}) {
  const meta = [
    info.lastActiveAt ? formatAgo(info.lastActiveAt) : null,
    info.durationMs > 0 ? formatShortDuration(info.durationMs) : null,
    info.costUsd > 0 ? formatUsd(info.costUsd) : null,
  ].filter(Boolean).join(' · ');
  const files = info.filesModified.map((f) => relativeTo(f, baseDir));
  const more = files.length - FILES_SHOWN;

  return (
    <section className="w-full mt-[30px] text-left" aria-label="Last session" data-testid="last-session">
      <SectionHead title="Last session" right={meta || undefined} />
      {info.summary && <Markdown text={info.summary} className="pt-0.5 pb-2.5 text-[13px] leading-[1.55] text-ctp-subtext1 break-words line-clamp-4" />}
      {branch && (
        <div className="h-[30px] flex items-center gap-2 px-2 -mx-2 min-w-0" data-testid="last-session-branch">
          <span className="flex-shrink-0 text-ctp-overlay1 flex"><BranchIcon /></span>
          <span className="font-mono text-xs text-ctp-text truncate">{branch}</span>
          {info.hasGit && info.ahead > 0 && (
            <span className="text-xs text-ctp-overlay1 whitespace-nowrap">
              {plural(info.ahead, 'commit')} ahead{info.remote ? ` of ${info.remote}` : ''}
            </span>
          )}
          {info.hasGit && (
            <span className="ml-auto text-xs text-ctp-overlay1 whitespace-nowrap">
              {info.uncommitted > 0 ? `${plural(info.uncommitted, 'uncommitted file')}` : 'nothing uncommitted'}
            </span>
          )}
        </div>
      )}
      {files.slice(0, FILES_SHOWN).map((f) => <FileRow key={f} path={f} height={30} />)}
      {(more > 0 || onBrowse) && (
        <div className="h-7 flex items-center text-xs text-ctp-overlay1">
          {more > 0 && <span>{plural(more, 'more file')}</span>}
          {onBrowse && (
            <button type="button" onClick={onBrowse} className="ml-auto text-ctp-accent hover:underline cursor-pointer focus-ring rounded" data-testid="browse-sessions-link">
              Browse sessions
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// Re-export with old name for backwards compatibility during migration
export { SleepingAgent as SleepingClaude };
