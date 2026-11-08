import { useEffect, useId, useRef, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useOrchestratorStore } from '../stores/orchestratorStore';
import { useEffectiveOrchestrators } from '../hooks/useEffectiveOrchestrators';
import { useModelOptions } from '../hooks/useModelOptions';
import { newAgentOrchestrator } from '../features/agents/effective-orchestrator';
import { useQuickAgentAccess } from '../features/agents/useQuickAgentAccess';
import { AccessSelect } from '../features/agents/AccessSelect';
import type { AccessLevel } from '../../shared/agent-access';
import { isTopModal, pushModal, removeModal } from '../components/layers';
import { useQuickPromptStore } from './quickPromptStore';
import { useChromeStore } from './chromeStore';
import { useUIStore } from '../stores/uiStore';
import { startingProject } from './starting-project';
import { openCreatedAgent } from './startPage';
import { reportChromeActionFailed, reportChromeFeature } from './telemetry';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const selectClass = 'bg-surface-0 border border-surface-2 rounded px-2 py-1 text-xs text-ctp-text focus-ring';

/**
 * ⌘N in the new layout (#2812): one line, Enter starts a quick agent in the
 * current project with the settings' defaults. Details, collapsed, change the
 * project, CLI, model or access for this one start. The full New agent page
 * stays on ⌘⇧N and in the New menu.
 */
export function QuickPrompt() {
  const open = useQuickPromptStore((s) => s.open);
  if (!open) return null;
  return <QuickPromptPanel />;
}

function QuickPromptPanel() {
  const close = useQuickPromptStore((s) => s.closePrompt);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const dispatcherOpen = useUIStore((s) => s.dispatcherOpen);
  const lastProjectId = useChromeStore((s) => s.lastProjectId);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const { effectiveOrchestrators } = useEffectiveOrchestrators();

  // As the New agent page decides it, once per open. With no project in view (the
  // Dispatcher, Canvas, Settings), the field asks for one, starting at the last used.
  const [initial] = useState(() => startingProject(projects, { activeProjectId, explorerTab, lastProjectId, dispatcherOpen }));
  const current = initial.inView;
  const [projectId, setProjectId] = useState(initial.id);
  const project = projects.find((p) => p.id === projectId);
  const [mission, setMission] = useState('');
  const [details, setDetails] = useState(false);
  const [orchestrator, setOrchestrator] = useState('');
  const [model, setModel] = useState('default');
  const [pickedAccess, setPickedAccess] = useState<AccessLevel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The project's "Agents run on" (#2975) until picked here.
  const runOrchestrator = orchestrator || newAgentOrchestrator(project, effectiveOrchestrators);
  const { options: modelOptions } = useModelOptions(runOrchestrator, project?.path);
  const { start: startAccess, defaultAccess } = useQuickAgentAccess(project?.path, undefined);
  const supportsPermissions = allOrchestrators.find((o) => o.id === runOrchestrator)?.capabilities?.permissions ?? false;
  // A CLI without permission support starts at Ask first.
  const access: AccessLevel = supportsPermissions ? pickedAccess ?? startAccess : 'ask';

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const detailsId = useId();
  const errorId = useId();

  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Esc and Tab are handled for the whole document while it's open, as Modal does, so
  // they work wherever focus is: Esc closes it (not mid-composition or while starting),
  // and Tab stays inside.
  useEffect(() => {
    const token = Symbol('quick-prompt');
    pushModal(token);
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!isTopModal(token)) return;
      const dialog = dialogRef.current;
      if (e.key === 'Escape') {
        if (e.isComposing || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        if (!busyRef.current) close();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const all = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (all.length === 0) { e.preventDefault(); dialog.focus(); return; }
      const first = all[0];
      const last = all[all.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !dialog.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      removeModal(token);
      if (previous?.isConnected && (document.activeElement === document.body || dialogRef.current?.contains(document.activeElement))) previous.focus();
    };
  }, [close]);

  // A disabled field loses focus while starting: give it back when a start fails.
  useEffect(() => { if (!busy) inputRef.current?.focus(); }, [busy]);

  const start = () => {
    const task = mission.trim();
    if (!task || busy) return;
    if (!project) { setError('Choose a project to start it in.'); return; }
    setBusy(true);
    setError(null);
    reportChromeFeature('quick_prompt_start');
    const target = project;
    useAgentStore.getState().spawnQuickAgent(
      target.id, target.path, task, model, undefined, runOrchestrator,
      // Only a level picked here; otherwise spawnQuickAgent uses the Default access.
      supportsPermissions ? pickedAccess ?? undefined : 'ask',
      undefined, undefined, { fallbackAccess: defaultAccess },
    ).then((id) => {
      close();
      openCreatedAgent(target.id, id);
    }).catch((err) => {
      reportChromeActionFailed('agent_start', err);
      setBusy(false);
      setError(`Couldn't start the agent: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const projectSelect = (
    <select
      aria-label="Project"
      data-testid="quick-prompt-project"
      value={projectId}
      disabled={busy}
      onChange={(e) => { setProjectId(e.target.value); setOrchestrator(''); setModel('default'); setPickedAccess(null); }}
      className={`${selectClass} max-w-[40%]`}
    >
      {projects.map((p) => <option key={p.id} value={p.id}>{p.displayName || p.name}</option>)}
    </select>
  );

  return (
    // eslint-disable-next-line no-restricted-syntax
    <div className="fixed inset-0 z-modal" data-testid="quick-prompt-overlay">
      <div className="absolute inset-0 bg-ctp-crust/40" onClick={() => { if (!busy) close(); }} />
      <div className="relative flex justify-center pt-[12vh] px-4 pointer-events-none">
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="New quick agent"
          data-testid="quick-prompt"
          className="pointer-events-auto w-[560px] max-w-full bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl overflow-hidden"
        >
          <form
            className="flex items-center gap-2 px-3 h-11"
            onSubmit={(e) => { e.preventDefault(); start(); }}
          >
            {!current && projectSelect}
            <input
              ref={inputRef}
              aria-label="What should this quick agent do?"
              aria-describedby={error ? errorId : undefined}
              data-testid="quick-prompt-input"
              value={mission}
              disabled={busy}
              onChange={(e) => setMission(e.target.value)}
              placeholder={project ? `What should this quick agent do in ${project.displayName || project.name}?` : 'What should this quick agent do?'}
              className="flex-1 min-w-0 bg-transparent text-sm text-ctp-text placeholder:text-ctp-overlay0 outline-none"
            />
            <button
              type="button"
              aria-expanded={details}
              aria-controls={detailsId}
              onClick={() => setDetails((d) => !d)}
              className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
            >
              Details
            </button>
          </form>
          {details && (
            <div id={detailsId} className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-surface-0" data-testid="quick-prompt-details">
              {current && projectSelect}
              <select
                aria-label="Runs on"
                value={runOrchestrator}
                disabled={busy}
                onChange={(e) => { setOrchestrator(e.target.value); setModel('default'); setPickedAccess(null); }}
                className={selectClass}
              >
                {effectiveOrchestrators.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
              </select>
              <select aria-label="Model" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)} className={selectClass}>
                {modelOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <AccessSelect
                value={access}
                onChange={setPickedAccess}
                providerId={runOrchestrator}
                disabled={busy || !supportsPermissions}
                data-testid="quick-prompt-access"
                className={selectClass}
              />
            </div>
          )}
          {error && <p id={errorId} role="alert" className="px-3 py-2 text-xs text-ctp-red border-t border-surface-0">{error}</p>}
          <div className="h-[30px] flex items-center gap-3 px-3 border-t border-surface-0 text-xs text-ctp-overlay1">
            <span>{busy ? 'Starting…' : '↵ start'}</span>
            <span>esc close</span>
          </div>
        </div>
      </div>
    </div>
  );
}
