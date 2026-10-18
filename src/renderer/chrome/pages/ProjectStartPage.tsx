import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { useUIStore } from '../../stores/uiStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useChromeStore } from '../chromeStore';
import { openNewAgentOrDialog } from '../startPage';
import { reportChromeActionFailed, reportChromeFeature } from '../telemetry';
import type { Agent, CompletedQuickAgent, Project } from '../../../shared/types';
import { markdownToPlainText } from '../../utils/safe-markdown';

/**
 * The project start page (docs/chrome-redesign-spec.md §2): the pane for a
 * selected project header on the Agents tab. A composer starts a quick agent or
 * wakes a sleeping durable agent with a prompt, and below it the project's
 * finished quick agents wait to be read and dismissed. Replaces Home, and is an
 * experiment: its feature-usage events decide whether it stays (spec §11).
 */

const QUICK = '';
const EMPTY: CompletedQuickAgent[] = [];

function ago(ts: number, now: number): string {
  const min = Math.max(0, Math.round((now - ts) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const selectClass = 'h-7 bg-surface-0 border border-surface-1 rounded-md px-2 text-xs text-ctp-text focus-ring cursor-pointer';
const linkClass = 'text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer';

function Composer({ project }: { project: Project }) {
  const agents = useAgentStore((s) => s.agents);
  const spawnQuickAgent = useAgentStore((s) => s.spawnQuickAgent);
  const spawnDurableAgent = useAgentStore((s) => s.spawnDurableAgent);
  const setProjectScope = useChromeStore((s) => s.setProjectScope);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledIds = useOrchestratorStore((s) => s.enabled);
  const orchestrators = useMemo(() => allOrchestrators.filter((o) => enabledIds.includes(o.id)), [allOrchestrators, enabledIds]);

  const sleeping = useMemo(
    () => Object.values(agents).filter((a): a is Agent => a.projectId === project.id && a.kind === 'durable' && a.status === 'sleeping'),
    [agents, project.id],
  );

  const [prompt, setPrompt] = useState('');
  const [runAs, setRunAs] = useState(QUICK);
  const [orchestrator, setOrchestrator] = useState('');
  const [model, setModel] = useState('default');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resolvedOrchestrator = orchestrator || orchestrators[0]?.id || '';
  const { options: modelOptions } = useModelOptions(resolvedOrchestrator || undefined);

  // A different project is a different composer; a woken agent leaves the list.
  useEffect(() => { setRunAs(QUICK); setPrompt(''); setFailed(false); }, [project.id]);
  useEffect(() => {
    if (runAs !== QUICK && !sleeping.some((a) => a.id === runAs)) setRunAs(QUICK);
  }, [runAs, sleeping]);

  const isQuick = runAs === QUICK;
  const canStart = prompt.trim().length > 0 && !busy;

  const start = async () => {
    const mission = prompt.trim();
    if (!mission || busy) return;
    setBusy(true);
    setFailed(false);
    reportChromeFeature('start_page_start');
    try {
      if (isQuick) {
        await spawnQuickAgent(project.id, project.path, mission, model, undefined, resolvedOrchestrator || undefined);
      } else {
        const configs = await window.clubhouse.agent.listDurable(project.path);
        const config = configs.find((c: { id: string }) => c.id === runAs);
        if (!config) throw new Error('Durable agent config not found');
        await spawnDurableAgent(project.id, project.path, config, false, mission);
      }
      setPrompt('');
      // The started agent is the new selection, so its worktree becomes the scope.
      setProjectScope(null);
    } catch (err) {
      // A spawn that got as far as adding the agent selects it, errored, which
      // ends the project scope and shows it. Anything earlier stays here.
      reportChromeActionFailed('agent_start', err);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={inputRef}
        data-testid="start-page-prompt"
        aria-label={`What should an agent do in ${project.displayName || project.name}?`}
        value={prompt}
        onChange={(e) => { setPrompt(e.target.value); setFailed(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void start(); }
        }}
        placeholder={`What should an agent do in ${project.displayName || project.name}?`}
        rows={4}
        className="w-full bg-ctp-mantle border border-surface-1 rounded-lg px-3 py-2.5 text-sm text-ctp-text placeholder:text-ctp-overlay0 focus-ring resize-none"
      />
      {failed && (
        <p role="alert" data-testid="start-page-error" className="text-xs text-ctp-error">
          The agent didn’t start. Check the orchestrator in Settings, then try again.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Run as" data-testid="start-page-run-as" value={runAs} onChange={(e) => setRunAs(e.target.value)} className={selectClass}>
          <option value={QUICK}>New quick agent</option>
          {sleeping.length > 0 && (
            <optgroup label="Wake a sleeping agent">
              {sleeping.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
          )}
        </select>
        {isQuick && orchestrators.length > 1 && (
          <select aria-label="Orchestrator" value={resolvedOrchestrator} onChange={(e) => { setOrchestrator(e.target.value); setModel('default'); }} className={selectClass}>
            {orchestrators.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
          </select>
        )}
        {isQuick && (
          <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} className={selectClass}>
            {modelOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}
        <span className="ml-auto text-xs text-ctp-overlay1">{window.clubhouse.platform === 'darwin' ? '⌘' : 'Ctrl+'}Enter</span>
        <button
          type="button"
          data-testid="start-page-start"
          disabled={!canStart}
          onClick={() => void start()}
          className="h-7 px-3 rounded-md bg-ctp-accent text-white text-xs font-medium cursor-pointer hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isQuick ? 'Start' : 'Wake'}
        </button>
      </div>
    </div>
  );
}

function FinishedList({ projectId }: { projectId: string }) {
  const completed = useQuickAgentStore((s) => s.completedAgents[projectId] ?? EMPTY);
  const setProjectScope = useChromeStore((s) => s.setProjectScope);
  const now = Date.now();
  if (completed.length === 0) return null;

  const open = (id: string) => {
    setProjectScope(null);
    useAgentStore.getState().setActiveAgent(null, projectId);
    useQuickAgentStore.getState().selectCompleted(id);
    reportChromeFeature('completed_open');
  };

  return (
    <section aria-labelledby="start-page-finished" className="flex flex-col gap-1" data-testid="start-page-finished">
      <div className="flex items-baseline gap-2 pb-1">
        <h2 id="start-page-finished" className="text-sm font-semibold text-ctp-text">Finished, waiting on you</h2>
        <span className="text-xs text-ctp-overlay1">{completed.length}</span>
        <button
          type="button"
          onClick={() => { useQuickAgentStore.getState().clearCompleted(projectId); reportChromeFeature('completed_clear'); }}
          className={`ml-auto ${linkClass}`}
        >
          Clear all
        </button>
      </div>
      <ul className="flex flex-col">
        {completed.map((c) => (
          <li key={c.id} className="group/finished flex items-start gap-2 rounded-md hover:bg-surface-0/60">
            <button
              type="button"
              data-testid={`start-page-finished-${c.id}`}
              onClick={() => open(c.id)}
              className="flex-1 min-w-0 text-left px-2 py-1.5 cursor-pointer"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] text-ctp-text truncate">{c.mission || c.name}</span>
                <span className="ml-auto flex-shrink-0 text-xs text-ctp-overlay1">{ago(c.completedAt, now)}</span>
              </div>
              <div className="text-xs text-ctp-subtext0 truncate">
                {c.exitCode !== 0 ? `Exited with code ${c.exitCode}` : (c.summary && markdownToPlainText(c.summary)) || `${c.filesModified.length} file${c.filesModified.length === 1 ? '' : 's'} changed`}
              </div>
            </button>
            <button
              type="button"
              aria-label={`Dismiss ${c.name}`}
              onClick={() => { useQuickAgentStore.getState().dismissCompleted(projectId, c.id); reportChromeFeature('completed_dismiss'); }}
              className={`mt-1.5 mr-1.5 px-1.5 rounded ${linkClass} opacity-0 group-hover/finished:opacity-100 focus-visible:opacity-100`}
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ProjectStartPage({ project }: { project: Project }) {
  const openProjectSettings = useUIStore((s) => s.openProjectSettings);

  return (
    <div className="h-full overflow-y-auto bg-ctp-base" data-testid="start-page">
      <div className="max-w-2xl mx-auto px-6 pt-16 pb-10 flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold text-ctp-text truncate">{project.displayName || project.name}</h1>
            <span className="text-xs text-ctp-overlay1 truncate font-mono">{project.path}</span>
          </div>
          <Composer project={project} />
          <div className="flex gap-4">
            <button type="button" onClick={() => { openNewAgentOrDialog('durable', project.id); reportChromeFeature('new_agent_open'); }} className={linkClass}>
              New durable agent…
            </button>
            <button type="button" data-testid="start-page-settings" onClick={() => openProjectSettings(project.id)} className={linkClass}>
              Project settings
            </button>
          </div>
        </div>
        <FinishedList projectId={project.id} />
      </div>
    </div>
  );
}
