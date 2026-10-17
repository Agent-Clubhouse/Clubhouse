import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AgentInfo, PluginAPI } from '../../../../shared/plugin-types';
import type { SessionEvent, SessionSummary } from '../../../../shared/session-types';
import { Button, Toggle } from './host';
import { StatusDot } from '../../../chrome/sidebar/AgentRow';
import { formatDuration } from '../../../chrome/sidebar/AgentHoverCard';
import { ReviewAvatar, Svg, Icon, useProjectName } from './reviewUi';
import { timeAgo } from './reviewModel';
import { wakeAgent } from './wake';

/**
 * The card Review shows for a sleeping agent (#2021): what its last session
 * did, a prompt to wake it with, and Skip or Wake. Replaces the full-page
 * SleepingAgent widget inside Review only.
 */

export interface SleepingCardHandle {
  wake: () => void;
  focusPrompt: () => void;
}

interface LastSession {
  title: string | null;
  endedAt: string | null;
  summary: SessionSummary | null;
  firstPrompt: string | null;
  replies: string[];
}

const TRANSCRIPT_HEAD = 20;
const TRANSCRIPT_TAIL = 40;

async function loadLastSession(api: PluginAPI, agentId: string): Promise<LastSession | null> {
  const sessions = await api.agents.listSessions(agentId).catch((): Awaited<ReturnType<PluginAPI["agents"]["listSessions"]>> => []);
  if (!sessions.length) return null;
  const last = [...sessions].sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))[0];
  const [summary, head] = await Promise.all([
    api.agents.getSessionSummary(agentId, last.sessionId).catch((): null => null),
    api.agents.readSessionTranscript(agentId, last.sessionId, 0, TRANSCRIPT_HEAD).catch((): null => null),
  ]);
  let events: SessionEvent[] = head?.events ?? [];
  const total = head?.totalEvents ?? 0;
  if (total > TRANSCRIPT_HEAD) {
    const tail = await api.agents.readSessionTranscript(agentId, last.sessionId, Math.max(TRANSCRIPT_HEAD, total - TRANSCRIPT_TAIL), TRANSCRIPT_TAIL).catch((): null => null);
    events = [...events, ...(tail?.events ?? [])];
  }
  const firstPrompt = events.find((e) => e.type === 'user_message' && e.text?.trim())?.text?.trim() ?? null;
  const replies = events.filter((e) => e.type === 'assistant_message' && e.text?.trim()).slice(-2).map((e) => e.text!.trim());
  return { title: last.friendlyName ?? null, endedAt: summary?.lastActiveAt ?? last.lastActiveAt, summary, firstPrompt, replies };
}

export const SleepingCard = React.forwardRef<SleepingCardHandle, {
  api: PluginAPI;
  agent: AgentInfo;
  onSkip: () => void;
  /** Esc in the prompt hands the keys back to browsing. */
  onLeavePrompt: () => void;
}>(function SleepingCard({ api, agent, onSkip, onLeavePrompt }, ref) {
  const [last, setLast] = useState<LastSession | null | undefined>(undefined);
  const [prompt, setPrompt] = useState('');
  const [resume, setResume] = useState(true);
  const [waking, setWaking] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const projectName = useProjectName(agent.projectId);

  useEffect(() => {
    let live = true;
    setLast(undefined);
    setPrompt('');
    setWaking(false);
    loadLastSession(api, agent.id).then((s) => { if (live) setLast(s); }).catch(() => { if (live) setLast(null); });
    return () => { live = false; };
  }, [api, agent.id]);

  const wake = useCallback(() => {
    if (waking) return;
    setWaking(true);
    wakeAgent(agent.id, { resume: resume && !!last, prompt }).catch(() => setWaking(false));
  }, [agent.id, resume, last, prompt, waking]);

  useImperativeHandle(ref, () => ({ wake, focusPrompt: () => promptRef.current?.focus() }), [wake]);

  const onPromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); wake(); }
    else if (e.key === 'Escape') { e.preventDefault(); onLeavePrompt(); }
  };

  const ended = timeAgo(last?.endedAt);
  const duration = last?.summary?.totalDurationMs ? formatDuration(last.summary.totalDurationMs) : null;
  const files = last?.summary?.filesModified.length ?? 0;
  const title = last?.title || last?.summary?.summary?.split('\n')[0] || last?.firstPrompt?.split('\n')[0] || 'Untitled session';

  return (
    <div className="h-full w-full overflow-y-auto" data-testid="review-sleeping-card">
      <div className="mx-auto max-w-[580px] px-4 pt-12 pb-8 flex flex-col gap-3.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <ReviewAvatar agentId={agent.id} size="xs" />
          <span className="text-[15px] font-semibold text-ctp-text truncate">{agent.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-ctp-overlay1 flex-shrink-0"><StatusDot dot="sleeping" />Sleeping</span>
          {projectName && <span className="ml-auto text-xs text-ctp-overlay1 truncate">{projectName}</span>}
        </div>

        {last === undefined ? (
          <div className="h-9 flex items-center text-xs text-ctp-overlay1">Loading the last session</div>
        ) : last === null ? (
          <div className="text-xs text-ctp-overlay1">No earlier sessions. Waking starts a new one.</div>
        ) : (
          <div className="rounded-lg border border-surface-0 overflow-hidden" data-testid="review-last-session">
            <div className="h-9 flex items-center gap-2.5 px-3 border-b border-surface-0 bg-ctp-mantle min-w-0">
              <span className="text-xs text-ctp-overlay1 flex-shrink-0">Last session</span>
              <span className="text-[13px] font-medium text-ctp-text truncate">{title}</span>
              {(ended || duration) && (
                <span className="ml-auto text-xs text-ctp-overlay1 flex-shrink-0">
                  {[ended && `ended ${ended}`, duration].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
            {(last.firstPrompt || last.replies.length > 0 || last.summary?.summary) && (
              <div className="p-3 flex flex-col gap-2 text-[12.5px] leading-normal">
                {last.firstPrompt && (
                  <div className="self-end max-w-[80%] px-2.5 py-1.5 rounded-lg bg-surface-0 text-ctp-text line-clamp-3 whitespace-pre-wrap">{last.firstPrompt}</div>
                )}
                {(last.replies.length > 0 ? last.replies : [last.summary?.summary ?? '']).filter(Boolean).map((text, i) => (
                  <div key={i} className="text-ctp-subtext1 line-clamp-3 whitespace-pre-wrap">{text}</div>
                ))}
              </div>
            )}
            {(agent.branch || files > 0) && (
              <div className="h-8 flex items-center gap-2 px-3 border-t border-surface-0 text-xs text-ctp-overlay1 min-w-0">
                {agent.branch && <><Svg size={13}>{Icon.branch}</Svg><span className="font-mono truncate">{agent.branch}</span></>}
                {files > 0 && <span className="flex-shrink-0">{files} file{files === 1 ? '' : 's'} changed</span>}
              </div>
            )}
          </div>
        )}

        <div className="rounded-lg border border-surface-1 bg-ctp-mantle">
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onPromptKeyDown}
            rows={2}
            aria-label={`Prompt for ${agent.name} when it wakes`}
            data-testid="review-wake-prompt"
            placeholder={`Tell ${agent.name} what to do when it wakes…`}
            className="w-full resize-none bg-transparent px-3.5 py-3 text-[13px] text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none"
          />
          <div className="flex items-center gap-2 pl-3 pr-2 py-1.5 border-t border-surface-0 text-xs text-ctp-subtext1">
            {last && (
              <label className="flex items-center gap-2 cursor-pointer">
                <Toggle checked={resume} onChange={setResume} aria-label="Resume last session" />
                Resume last session
              </label>
            )}
            <span className="ml-auto flex items-center gap-2">
              <Button kind="ghost" onClick={onSkip} data-testid="review-skip">Skip</Button>
              <Button kind="primary" icon={<Svg>{Icon.bolt}</Svg>} onClick={wake} disabled={waking} data-testid="review-wake">{waking ? 'Waking' : 'Wake'}</Button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});
