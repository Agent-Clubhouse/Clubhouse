import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpCatalogEntry, Project } from '../../../shared/types';
import { AGENT_COLORS, generateDurableName } from '../../../shared/name-generator';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useEffectiveOrchestrators } from '../../hooks/useEffectiveOrchestrators';
import { useModelOptions } from '../../hooks/useModelOptions';
import { PERSONA_TEMPLATES } from '../../features/personas';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import { Toggle } from '../../components/Toggle';
import { Button } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { createDurableAgent } from '../../features/agents/create-agent';
import { useChromeStore, settleNewAgent, type NewAgentRequest } from '../chromeStore';
import { useChromeDialogStore } from '../sidebar/ChromeAgentDialogs';
import { openStartPage } from '../startPage';
import { ProjectPicker } from './ProjectPicker';
import { reportChromeActionFailed, reportChromeFeature } from '../telemetry';

/**
 * The New agent page (#2031): one form in the pane for every way of making an
 * agent (the sidebar's New menu, a project's +, ⌘⇧N). No prompt box: Project,
 * Kind (Durable by default, or Quick), then the fields AddAgentDialog had.
 * Quick swaps the durable-only rows for a required Mission and Runs in.
 */

const IS_MAC = typeof window !== 'undefined' && window.clubhouse?.platform === 'darwin';

const inputClass = 'h-7 px-2 rounded-md border border-surface-1 bg-ctp-crust text-[13px] text-ctp-text placeholder:text-ctp-overlay0 focus-ring';
const selectClass = `${inputClass} pr-6 cursor-pointer`;
const mono = 'font-mono text-xs';

function Row({ label, htmlFor, help, top, children }: { label: string; htmlFor?: string; help?: React.ReactNode; top?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex gap-4 py-1.5 ${top ? 'items-start' : 'items-center'}`}>
      <label htmlFor={htmlFor} className={`flex-shrink-0 w-28 text-[13px] text-ctp-subtext1 ${top ? 'pt-1.5' : ''}`}>{label}</label>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">{children}</div>
        {help && <div className="text-xs leading-normal text-ctp-overlay1">{help}</div>}
      </div>
    </div>
  );
}

const Rule = () => <div className="h-px bg-surface-0 my-2" />;

const RandomizeIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
  </svg>
);

/** Which project the page starts on, and why (for the help line). */
function useStartingProject(request: NewAgentRequest, projects: Project[]): { id: string; why: string } {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const lastProjectId = useChromeStore((s) => s.lastProjectId);
  // Decided once per open: later navigation doesn't move the picker.
  const [start] = useState(() => {
    const has = (id: string | null | undefined): id is string => !!id && projects.some((p) => p.id === id);
    if (has(request.projectId)) return { id: request.projectId, why: '' };
    if (projects.length === 1) return { id: projects[0].id, why: '' };
    // On Canvas, Review, Settings or Help no project is highlighted in the sidebar.
    const projectInView = explorerTab !== 'settings' && explorerTab !== 'help' && !explorerTab.startsWith('plugin:app:');
    if (projectInView && has(activeProjectId)) return { id: activeProjectId, why: 'selected in the sidebar' };
    if (has(lastProjectId)) return { id: lastProjectId, why: 'the last project you used' };
    if (has(activeProjectId)) return { id: activeProjectId, why: 'the last project you used' };
    return { id: projects[0]?.id ?? '', why: '' };
  });
  return start;
}

export function NewAgentPage({ request }: { request: NewAgentRequest }) {
  const projects = useProjectStore((s) => s.projects);
  const projectIcons = useProjectStore((s) => s.projectIcons);
  const pickAndAddProject = useProjectStore((s) => s.pickAndAddProject);
  const activity = useChromeStore((s) => s.projectActivity);
  const close = useChromeStore((s) => s.closeNewAgent);
  const agents = useAgentStore((s) => s.agents);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const availability = useOrchestratorStore((s) => s.availability);

  const start = useStartingProject(request, projects);
  const [projectId, setProjectId] = useState(start.id);
  const project = projects.find((p) => p.id === projectId);
  const [kind, setKind] = useState(request.kind);
  const durable = kind === 'durable';

  const [name, setName] = useState(generateDurableName);
  const [color, setColor] = useState<string>(AGENT_COLORS[0].id);
  const { effectiveOrchestrators } = useEffectiveOrchestrators(project?.path);
  const [orchestrator, setOrchestrator] = useState('');
  const resolvedOrchestrator = orchestrator || effectiveOrchestrators[0]?.id || 'claude-code';
  const [model, setModel] = useState('default');
  const [customModel, setCustomModel] = useState('');
  const [persona, setPersona] = useState('');
  const [useWorktree, setUseWorktree] = useState(true);
  const [isGit, setIsGit] = useState<boolean | null>(null);
  const [freeAgentMode, setFreeAgentMode] = useState(false);
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [selectedMcps, setSelectedMcps] = useState<string[]>([]);
  const [mission, setMission] = useState('');
  const [parentAgentId, setParentAgentId] = useState('');
  const missionRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // A quick agent under a durable one runs in its worktree with its orchestrator.
  const parent = parentAgentId ? agents[parentAgentId] : undefined;
  const runOrchestrator = !durable && parent?.orchestrator ? parent.orchestrator : resolvedOrchestrator;
  const { options: modelOptions, loading: modelsLoading } = useModelOptions(runOrchestrator, project?.path);
  const selectedOrch = allOrchestrators.find((o) => o.id === runOrchestrator);
  const supportsPermissions = selectedOrch?.capabilities?.permissions ?? false;
  const avail = availability[runOrchestrator];
  const durableAgents = useMemo(
    () => Object.values(agents).filter((a) => a.projectId === projectId && a.kind === 'durable'),
    [agents, projectId],
  );

  // The cursor starts in Name, or in Mission for a quick agent.
  useEffect(() => {
    (durable ? nameRef.current : missionRef.current)?.focus();
  }, [durable]);

  // Per project: git (the worktree row), the MCP catalog and its defaults.
  const projectPath = project?.path;
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    setIsGit(null);
    setParentAgentId('');
    setOrchestrator('');
    setModel('default');
    window.clubhouse.project.checkGit(projectPath)
      .then((git: boolean) => { if (!cancelled) setIsGit(!!git); })
      .catch(() => { if (!cancelled) setIsGit(false); });
    Promise.all([
      window.clubhouse.project.readMcpCatalog(projectPath),
      window.clubhouse.project.readDefaultMcps(projectPath),
    ]).then(([catalog, defaults]) => {
      if (cancelled) return;
      setMcpCatalog(catalog || []);
      setSelectedMcps(defaults || []);
    }).catch(() => {
      // telemetry-exempt: no catalog means the MCP row stays hidden, as in AddAgentDialog
      if (!cancelled) { setMcpCatalog([]); setSelectedMcps([]); }
    });
    return () => { cancelled = true; };
  }, [projectPath]);

  const resolvedModel = model === 'custom' ? customModel.trim() : model;
  const busy = useChromeStore((s) => s.newAgentBusy);
  const setBusy = useChromeStore((s) => s.setNewAgentBusy);
  const [error, setError] = useState<string | null>(null);
  // Durable waits for the git check, which decides the worktree row.
  const canSubmit = !!project && !busy && (durable
    ? !!name.trim() && isGit !== null
    : !!mission.trim() && (model !== 'custom' || !!customModel.trim()));

  // The page stays up, busy, until the agent exists; a failure is shown here
  // with the form intact. If the user left (or another New agent replaced this
  // one) meanwhile, only the opener hears how it ended: no navigation, and the
  // page now showing is left alone.
  const stillOpen = () => useChromeStore.getState().newAgent === request;
  const goBusy = () => setBusy(true, {
    projectIds: useProjectStore.getState().projects.map((p) => p.id),
    agentIds: Object.keys(useAgentStore.getState().agents),
  });
  const finish = (projectIdDone: string, agentId: string) => {
    if (!stillOpen()) { settleNewAgent(request, agentId); return; }
    request.onCreated?.(agentId);
    close(agentId);
    if (!request.stayInView) {
      openStartPage(projectIdDone);
      selectAgent(projectIdDone, agentId);
    }
  };
  const failed = (message: string) => {
    if (!stillOpen()) { settleNewAgent(request, null); return; }
    setBusy(false);
    setError(message);
  };

  const submit = () => {
    if (!project || !canSubmit) return;
    setError(null);
    goBusy();
    const target = project;
    if (durable) {
      reportChromeFeature('new_agent_create');
      void createDurableAgent(
        { id: target.id, path: target.path },
        {
          name: name.trim(),
          color,
          model: resolvedModel,
          useWorktree: !!isGit && useWorktree,
          orchestrator: resolvedOrchestrator,
          freeAgentMode: (supportsPermissions && freeAgentMode) || undefined,
          mcpIds: selectedMcps.length > 0 ? selectedMcps : undefined,
          persona: persona || undefined,
        },
        { onError: (message) => failed(`Couldn't create the agent: ${message}`) },
      ).then((id) => { if (id) finish(target.id, id); });
    } else {
      reportChromeFeature('new_agent_start');
      useAgentStore.getState().spawnQuickAgent(
        target.id,
        target.path,
        mission.trim(),
        resolvedModel,
        parentAgentId || undefined,
        parentAgentId ? undefined : resolvedOrchestrator,
        (supportsPermissions && freeAgentMode) || undefined,
      ).then((id) => finish(target.id, id))
        .catch((err) => {
          reportChromeActionFailed('agent_start', err);
          failed(`Couldn't start the agent: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && !busy && !e.defaultPrevented && !(e.target as HTMLElement).closest('[data-testid="project-picker"]')) {
      e.preventDefault();
      close();
    }
  };

  // Adding a project makes it active; that selection is the page's own and doesn't close it.
  const addProject = () => {
    goBusy();
    pickAndAddProject()
      .then((added) => { if (added && stillOpen()) setProjectId(added.id); })
      .catch((err) => reportChromeActionFailed('add_project', err))
      .finally(() => { if (stillOpen()) setBusy(false); else settleNewAgent(request, null); });
  };

  const openTemplates = () => {
    if (!project) return;
    close();
    useChromeDialogStore.getState().openGallery(project.id);
    reportChromeFeature('new_agent_open');
  };

  const projectName = project ? project.displayName || project.name : '';

  return (
    <div data-testid="new-agent-page" className="h-full overflow-y-auto bg-ctp-base" onKeyDown={onKeyDown}>
      <form
        aria-labelledby="new-agent-title"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="w-[600px] max-w-full mx-auto px-6 pt-12 pb-10 flex flex-col"
      >
        <div className="mb-[18px]">
          <h1 id="new-agent-title" className="text-lg font-semibold text-ctp-text">New agent</h1>
          <p className="mt-1 text-[13px] text-ctp-overlay1">
            {durable ? `Creates a durable agent in ${projectName}.` : `Starts a quick agent in ${projectName}.`}
          </p>
        </div>

        <Row label="Project" help={projects.length > 1 && projectId === start.id && start.why ? `Starts on ${projectName}, ${start.why}.` : undefined}>
          <ProjectPicker projects={projects} projectIcons={projectIcons} activity={activity} value={projectId} onChange={setProjectId} onAddProject={addProject} />
        </Row>

        <Row
          label="Kind"
          help={durable
            ? 'Keeps its name, settings and history. You start it and talk to it whenever you like.'
            : 'Runs one mission, reports back, and finishes.'}
        >
          <div role="radiogroup" aria-label="Kind" className="inline-flex p-0.5 gap-0.5 rounded-[7px] bg-ctp-crust">
            {(['durable', 'quick'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                data-testid={`new-agent-kind-${k}`}
                onClick={() => setKind(k)}
                className={`h-6 px-3 rounded-[5px] text-xs cursor-pointer focus-ring ${kind === k ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext0 hover:text-ctp-text'}`}
              >
                {k === 'durable' ? 'Durable' : 'Quick'}
              </button>
            ))}
          </div>
        </Row>

        <Rule />

        {durable ? (
          <>
            <Row label="Name" htmlFor="new-agent-name" help="Generated. Change it now or rename it later.">
              <AgentAvatar agent={{ id: 'new', name, color, kind: 'durable', status: 'sleeping' } as never} size="2xs" />
              <input
                id="new-agent-name"
                ref={nameRef}
                data-testid="new-agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`${inputClass} w-[220px]`}
                spellCheck={false}
                autoComplete="off"
              />
              <Tooltip content="Randomize">
                <Button kind="quiet" aria-label="Randomize name" icon={RandomizeIcon} onClick={() => setName(generateDurableName())} className="focus-ring" />
              </Tooltip>
            </Row>
            <Row label="Color">
              <div role="radiogroup" aria-label="Color" className="inline-flex items-center gap-1.5">
                {AGENT_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={color === c.id}
                    aria-label={c.label}
                    title={c.label}
                    onClick={() => setColor(c.id)}
                    className={`w-5 h-5 rounded-full flex items-center justify-center cursor-pointer focus-ring ${color === c.id ? 'border-[1.5px] border-ctp-text' : ''}`}
                  >
                    <span className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: c.hex }} />
                  </button>
                ))}
              </div>
            </Row>
            <Rule />
          </>
        ) : (
          <>
            <Row label="Mission" htmlFor="new-agent-mission" top help="Required. A quick agent runs this one prompt and finishes.">
              <textarea
                id="new-agent-mission"
                ref={missionRef}
                data-testid="new-agent-mission"
                required
                value={mission}
                onChange={(e) => setMission(e.target.value)}
                placeholder={`What should the agent do in ${projectName}?`}
                className="flex-1 h-24 px-2.5 py-2 rounded-md border border-surface-1 bg-ctp-crust text-[13px] leading-normal text-ctp-text placeholder:text-ctp-overlay0 focus-ring resize-none"
              />
            </Row>
            <Rule />
            <Row label="Runs in" htmlFor="new-agent-runs-in" help="Or inside a durable agent’s worktree, so it works on that branch.">
              <select id="new-agent-runs-in" value={parentAgentId} onChange={(e) => setParentAgentId(e.target.value)} className={`${selectClass} w-[288px]`}>
                <option value="">Project root</option>
                {durableAgents.map((a) => <option key={a.id} value={a.id}>{a.name}’s worktree</option>)}
              </select>
            </Row>
          </>
        )}

        <Row
          label="Orchestrator"
          htmlFor="new-agent-orchestrator"
          help={avail && !avail.available
            ? <span className="text-ctp-warning">{avail.error || 'CLI not found. The agent may fail to start.'}</span>
            : parent ? `Uses ${parent.name}’s orchestrator.` : durable ? 'The model list follows the orchestrator.' : undefined}
        >
          <select
            id="new-agent-orchestrator"
            value={runOrchestrator}
            disabled={!!parent}
            onChange={(e) => { setOrchestrator(e.target.value); setModel('default'); }}
            className={`${selectClass} w-40 disabled:opacity-60 disabled:cursor-not-allowed`}
          >
            {(parent && !effectiveOrchestrators.some((o) => o.id === runOrchestrator) ? [...effectiveOrchestrators, ...allOrchestrators.filter((o) => o.id === runOrchestrator)] : effectiveOrchestrators).map((o) => {
              const a = availability[o.id];
              return <option key={o.id} value={o.id}>{o.displayName}{a && !a.available ? ' (not found)' : ''}</option>;
            })}
          </select>
          <select
            aria-label="Model"
            value={model}
            disabled={modelsLoading}
            onChange={(e) => setModel(e.target.value)}
            className={`${selectClass} w-[120px]`}
          >
            {modelsLoading ? <option value="default">Loading…</option> : modelOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            {!durable && !modelsLoading && <option value="custom">Custom…</option>}
          </select>
          {model === 'custom' && (
            <input aria-label="Custom model" value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="Model id" className={`${inputClass} w-36`} />
          )}
        </Row>

        {durable && (
          <Row label="Persona" htmlFor="new-agent-persona">
            <select id="new-agent-persona" data-testid="new-agent-persona" value={persona} onChange={(e) => setPersona(e.target.value)} className={`${selectClass} w-[288px]`}>
              <option value="">Project default</option>
              {PERSONA_TEMPLATES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Row>
        )}

        {durable && <Rule />}

        {durable && isGit && (
          <Row
            label="Worktree"
            help={useWorktree
              ? <>Branch <span className={mono}>{name.trim() || 'name'}/standby</span> from the current branch, checked out in <span className={mono}>.clubhouse/agents/{name.trim() || 'name'}</span>.</>
              : 'Works in the project folder, on whatever branch is checked out there.'}
          >
            <Toggle checked={useWorktree} onChange={setUseWorktree} aria-label="Own worktree and branch" />
            <span className="text-[13px] text-ctp-text">Own worktree and branch</span>
          </Row>
        )}

        <Row
          label="Permissions"
          help={!supportsPermissions
            ? `${selectedOrch?.displayName ?? 'This orchestrator'} doesn't support it.`
            : durable ? 'Skips every permission prompt. Off unless you trust this agent with the project.' : 'Skips every permission prompt.'}
        >
          <Toggle checked={supportsPermissions && freeAgentMode} onChange={setFreeAgentMode} disabled={!supportsPermissions} aria-label="Free Agent Mode" />
          <span className={`text-[13px] ${supportsPermissions ? 'text-ctp-text' : 'text-ctp-overlay1'}`}>Free Agent Mode</span>
        </Row>

        {durable && mcpCatalog.length > 0 && (
          <Row label="MCP servers" top help={`Project defaults from the MCP catalog, ${selectedMcps.length} of ${mcpCatalog.length}.`}>
            <div className="w-[288px] max-h-32 overflow-y-auto rounded-md border border-surface-1 bg-ctp-crust p-1.5 grid grid-cols-2 gap-x-2">
              {mcpCatalog.map((entry) => (
                <label key={entry.id} className="h-6 flex items-center gap-1.5 text-xs text-ctp-text cursor-pointer" title={entry.description}>
                  <input
                    type="checkbox"
                    checked={selectedMcps.includes(entry.id)}
                    onChange={() => setSelectedMcps((prev) => (prev.includes(entry.id) ? prev.filter((m) => m !== entry.id) : [...prev, entry.id]))}
                    className="w-3.5 h-3.5 accent-ctp-accent"
                  />
                  <span className="truncate">{entry.name}</span>
                </label>
              ))}
            </div>
          </Row>
        )}

        {error && (
          <p role="alert" data-testid="new-agent-error" className="mt-3 pl-32 text-xs leading-normal text-ctp-error">{error}</p>
        )}
        <div className="mt-[18px] pl-32 flex items-center gap-2">
          {durable && (
            <button type="button" onClick={openTemplates} className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer focus-ring rounded">
              From a template…
            </button>
          )}
          <span className="ml-auto text-xs text-ctp-overlay1">{IS_MAC ? '⌘↵' : 'Ctrl+Enter'}</span>
          <Button kind="ghost" onClick={() => close()} disabled={busy} className="focus-ring">Cancel</Button>
          <Button kind="primary" type="submit" data-testid="new-agent-submit" disabled={!canSubmit} aria-busy={busy || undefined} className="focus-ring">
            {busy ? (durable ? 'Creating…' : 'Starting…') : durable ? 'Create' : 'Start'}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Open a newly made agent, idle and ready for a first message. */
function selectAgent(projectId: string, agentId: string): void {
  if (useProjectStore.getState().activeProjectId !== projectId) return;
  useChromeStore.getState().setProjectScope(null);
  useUIStore.getState().setExplorerTab('agents', projectId);
  useAgentStore.getState().setActiveAgent(agentId, projectId);
}
