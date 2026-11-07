import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpCatalogEntry, Project } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID, isListed, type ManagedTemplate, type ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import { AGENT_COLORS, generateDurableName } from '../../../shared/name-generator';
import { validateAgentGitName } from '../../../shared/agent-name';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useEffectiveOrchestrators } from '../../hooks/useEffectiveOrchestrators';
import { useModelOptions } from '../../hooks/useModelOptions';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import { Toggle } from '../../components/Toggle';
import { Button } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { ImageCropDialog } from '../../components/ImageCropDialog';
import { createDurableAgent } from '../../features/agents/create-agent';
import { ManagedUiError, useManagedTemplates } from '../../features/managed/managedApi';
import { createManagedDurableAgent, type ManagedAgentInput } from '../../features/managed/create-managed-agent';
import type { SetupDraft } from '../../features/managed/ManagedBuilder';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';
import { useChromeStore, settleNewAgent, type NewAgentRequest } from '../chromeStore';
import { openCreatedAgent } from '../startPage';
import { ProjectPicker } from './ProjectPicker';
import { reportChromeActionFailed, reportChromeFeature } from '../telemetry';
import { IS_MAC, Row, Rule, footerLinkClass, inputClass, mono, selectClass } from './newAgentUi';
import { BuilderStep, CopyStep, SCRATCH_SEED, TemplateStep, draftFromSeed, templateSeed, type BuilderDraft, type BuilderSeed } from './NewManagedAgentSteps';

/**
 * The New agent page (#2031): one form in the pane for every way of making an
 * agent (the sidebar's New menu, a project's +, ⌘⇧N). No prompt box: Project,
 * Kind (Durable by default, or Quick), then the fields AddAgentDialog had.
 * Quick swaps the durable-only rows for a required Mission and Runs in.
 *
 * A durable agent asks for identity (adding an optional image), then
 * Clubhouse managed (#2893). On, the runtime rows give way to Build from
 * scratch, Start with template and Copy another agent, which are steps of
 * this page. Off, it is a plain agent with the runtime rows, plus the
 * Clubhouse features opt-out.
 */

const MANAGED_PREF_KEY = 'clubhouse.newAgent.managed';

/** The last Clubhouse managed choice; on when there is none or storage is unavailable. */
function readManagedPref(): boolean {
  try { return window.localStorage.getItem(MANAGED_PREF_KEY) !== 'off'; } catch { /* telemetry-exempt: storage unavailable, use the default */ return true; }
}
function writeManagedPref(on: boolean): void {
  try { window.localStorage.setItem(MANAGED_PREF_KEY, on ? 'on' : 'off'); } catch { /* telemetry-exempt: storage unavailable, the choice isn't remembered */ }
}

type Step = 'form' | 'templates' | 'builder' | 'copy';

/** Focus is somewhere that takes typing or its own keys. */
function isEditingTarget(el: HTMLElement): boolean {
  return el.isContentEditable || !!el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]');
}

/**
 * What a quick agent gets from a template (D25). It runs in a folder that
 * isn't its own, so nothing is written there: the instructions lead its
 * prompt, and its MCP servers go in the launch flags where the CLI has them.
 */
export function quickTemplateHelp(t: Pick<ManagedTemplate, 'setup'> | undefined, opts: { mcpLaunchFlags: boolean; cliName: string }): string {
  if (!t) return 'Optional. Starts the agent with a template’s instructions and MCP servers.';
  const parts = ['Its instructions lead the agent’s prompt.'];
  const servers = t.setup.mcps.filter((id) => id !== CLUBHOUSE_MCP_PART_ID).length;
  if (servers > 0) {
    const noun = servers === 1 ? 'Its MCP server' : `Its ${servers} MCP servers`;
    if (!opts.mcpLaunchFlags) parts.push(`${noun} can’t reach ${opts.cliName}, which reads them only from the folder’s own MCP file.`);
    else parts.push(`${noun} ${servers === 1 ? 'is' : 'are'} passed at launch.`);
  }
  if (t.setup.skills.length > 0) parts.push(`${t.setup.skills.length === 1 ? 'Its skill isn’t' : 'Its skills aren’t'} used, since a quick agent has no folder of its own.`);
  return parts.join(' ');
}

/** The Template row of a quick agent, under its mission. Mounted only with the flag on, so templates load only then. */
function QuickTemplateRow({ value, onChange, disabled, mcpLaunchFlags, cliName }: {
  value: string;
  onChange: (template: ManagedTemplate | null) => void;
  disabled: boolean;
  mcpLaunchFlags: boolean;
  cliName: string;
}) {
  const { value: templates, error } = useManagedTemplates();
  const selected = templates?.find((t) => t.id === value);
  return (
    <Row
      label="Template"
      htmlFor="new-agent-quick-template"
      help={error
        ? <span className="text-ctp-error" role="alert">{error}</span>
        : <span data-testid="new-agent-quick-template-help">{quickTemplateHelp(selected, { mcpLaunchFlags, cliName })}</span>}
    >
      <select
        id="new-agent-quick-template"
        data-testid="new-agent-quick-template"
        value={value}
        disabled={disabled || !templates}
        onChange={(e) => onChange(templates?.find((t) => t.id === e.target.value) ?? null)}
        className={`${selectClass} w-[288px]`}
      >
        <option value="">None</option>
        {(templates ?? []).filter((t) => isListed(t) || t.id === value).map((t) => <option key={t.id} value={t.id}>{t.name}{t.builtin ? '' : ' (yours)'}</option>)}
      </select>
    </Row>
  );
}

const failureText = (err: unknown) => (err instanceof ManagedUiError || err instanceof Error ? err.message : String(err));

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
  const [useWorktree, setUseWorktree] = useState(true);
  const [isGit, setIsGit] = useState<boolean | null>(null);
  const [freeAgentMode, setFreeAgentMode] = useState(false);
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [selectedMcps, setSelectedMcps] = useState<string[]>([]);
  const [mission, setMission] = useState('');
  const [parentAgentId, setParentAgentId] = useState('');
  const [quickTemplateId, setQuickTemplateId] = useState('');
  // Clubhouse-managed agents (#2893).
  const remote = isRemoteProjectId(projectId);
  const [managedPref, setManagedPref] = useState(readManagedPref);
  const isManaged = durable && !remote && managedPref;
  // A quick agent can start from a template (D25). It stays a quick agent: the
  // runtime rows stay, and the template only fills them in.
  const quickTemplates = !durable && !remote;
  const [clubhouseFeatures, setClubhouseFeatures] = useState(true);
  const [image, setImage] = useState<string | null>(null);
  const [cropUrl, setCropUrl] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('form');
  const [seed, setSeed] = useState<BuilderSeed | null>(null);
  // The builder's draft lives here, not in the step, so Back and forward to
  // the same start keep it, and a name problem found on Create can be fixed
  // on the form without losing it.
  const [draft, setDraft] = useState<BuilderDraft | null>(null);
  const [builderFrom, setBuilderFrom] = useState<Step>('form');
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

  /**
   * A template fills in the CLI, model and Free Agent Mode it sets. Each can still be changed.
   * Its model only when it belongs to the CLI that will run: the template's own CLI, or
   * one of the current CLI's models when the CLI stays (a parent fixes it, the template's
   * CLI isn't available, or the template names none).
   */
  const pickQuickTemplate = (t: ManagedTemplate | null) => {
    setQuickTemplateId(t?.id ?? '');
    if (!t) return;
    const { orchestrator: cli, model: m, freeAgentMode: free } = t.settings;
    const switchCli = !!cli && !parent && effectiveOrchestrators.some((o) => o.id === cli);
    if (switchCli) setOrchestrator(cli);
    const willRun = switchCli ? cli : runOrchestrator;
    if (m && ((cli && cli === willRun) || modelOptions.some((o) => o.id === m))) setModel(m);
    if (free !== undefined) setFreeAgentMode(free);
  };
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
  // With its own worktree a durable agent's name becomes a folder and a git
  // branch, so it is checked here as strictly as the main process will (#2221).
  // A managed agent always gets its own folder.
  const nameProblem = durable && (isManaged || (!!isGit && useWorktree)) && name.trim()
    ? validateAgentGitName(name.trim(), 'folder')
    : null;
  // Durable waits for the git check, which decides the worktree row.
  // The help line never shows a branch or folder the main process would refuse.
  const worktreeName = name.trim() && !nameProblem ? name.trim() : 'name';
  const identityOk = !!project && !!name.trim() && !nameProblem;
  const canSubmit = !!project && !busy && (durable
    ? identityOk && (isManaged || isGit !== null)
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
    if (!request.stayInView) openCreatedAgent(projectIdDone, agentId);
  };
  const failed = (message: string) => {
    if (!stillOpen()) { settleNewAgent(request, null); return; }
    setBusy(false);
    setError(message);
  };

  // The image is set once the agent exists; a failure leaves it without one.
  const saveImage = async (projectPath: string, agentId: string) => {
    if (!image) return;
    try { await useAgentStore.getState().saveAgentIcon(agentId, projectPath, image); } catch (err) { reportChromeActionFailed('agent_settings_save', err); }
  };

  const openStep = (next: Step) => { setError(null); setStep(next); };
  const openBuilder = (from: Step, next: BuilderSeed) => {
    setSeed(next);
    setDraft((held) => (held && held.key === next.key ? held : draftFromSeed(next)));
    setBuilderFrom(from);
    openStep('builder');
  };
  const back = () => { if (!busy) openStep(step === 'builder' ? builderFrom : 'form'); };

  /** Create a managed agent from a template as it is, or from the builder's parts and settings. */
  const createManaged = (input: Omit<ManagedAgentInput, 'name' | 'color'>) => {
    if (!project || busy || !identityOk) return;
    setError(null);
    goBusy();
    const target = project;
    reportChromeFeature('new_agent_create');
    createManagedDurableAgent({ id: target.id, path: target.path }, { name: name.trim(), color, ...input })
      .then(async (id) => { await saveImage(target.path, id); finish(target.id, id); })
      .catch((err) => {
        reportChromeActionFailed('agent_create', err);
        failed(`Couldn't create the agent: ${failureText(err)}`);
      });
  };
  const createFromTemplate = (t: ManagedTemplate) => createManaged({ templateId: t.id });
  const createFromBuilder = (setup: SetupDraft, settings: ManagedTemplateSettings) => createManaged({ setup, settings });

  const submit = () => {
    if (!project || !canSubmit) return;
    if (isManaged) { openStep('templates'); return; }
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
          clubhouseFeatures: !remote && !clubhouseFeatures ? false : undefined,
        },
        { onError: (message) => failed(`Couldn't create the agent: ${message}`) },
      ).then(async (id) => {
        if (!id) return;
        await saveImage(target.path, id);
        finish(target.id, id);
      });
    } else {
      reportChromeFeature('new_agent_start');
      const spawnQuick = useAgentStore.getState().spawnQuickAgent;
      const args = [
        target.id,
        target.path,
        mission.trim(),
        resolvedModel,
        parentAgentId || undefined,
        parentAgentId ? undefined : resolvedOrchestrator,
        (supportsPermissions && freeAgentMode) || undefined,
      ] as const;
      // Without a template the call is the same as before the flag.
      (quickTemplates && quickTemplateId
        ? spawnQuick(...args, undefined, undefined, { managedTemplateId: quickTemplateId })
        : spawnQuick(...args)
      ).then((id) => finish(target.id, id))
        .catch((err) => {
          reportChromeActionFailed('agent_start', err);
          failed(`Couldn't start the agent: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // The builder step handles its own ⌘↵.
      if (step !== 'form') return;
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && !busy && !e.defaultPrevented && !cropUrl
      && !(e.target as HTMLElement).closest('[data-testid="project-picker"], [role="dialog"]')) {
      // On a step, Esc in a field or editor belongs to that field: it never goes Back.
      if (step !== 'form' && isEditingTarget(e.target as HTMLElement)) return;
      e.preventDefault();
      if (step === 'form') close(); else back();
    }
  };

  const setManaged = (on: boolean) => { setManagedPref(on); writeManagedPref(on); };
  const pickImage = () => {
    void window.clubhouse.agent.pickIcon()
      .then((url) => { if (url) setCropUrl(url); })
      .catch((err) => reportChromeActionFailed('agent_settings_save', err));
  };

  // Adding a project makes it active; that selection is the page's own and doesn't close it.
  const addProject = () => {
    goBusy();
    pickAndAddProject()
      .then((added) => { if (added && stillOpen()) setProjectId(added.id); })
      .catch((err) => reportChromeActionFailed('add_project', err))
      .finally(() => { if (stillOpen()) setBusy(false); else settleNewAgent(request, null); });
  };

  const projectName = project ? project.displayName || project.name : '';

  if (step !== 'form' && project) {
    return (
      <div data-testid="new-agent-page" className="h-full overflow-y-auto bg-ctp-base" onKeyDown={onKeyDown}>
        {step === 'templates' && (
          <TemplateStep
            name={name.trim()}
            projectName={projectName}
            busy={busy}
            error={error}
            onCreate={createFromTemplate}
            onCustomize={(t) => openBuilder('templates', templateSeed(t))}
            onBack={back}
            onCancel={() => close()}
          />
        )}
        {step === 'copy' && (
          <CopyStep name={name.trim()} onPick={(next) => openBuilder('copy', next)} onBack={back} onCancel={() => close()} />
        )}
        {step === 'builder' && seed && draft && (
          <BuilderStep
            name={name.trim()}
            projectName={projectName}
            projectPath={project.path}
            seed={seed}
            draft={draft}
            onDraftChange={setDraft}
            busy={busy}
            error={error}
            canCreate={identityOk}
            onCreate={createFromBuilder}
            onBack={back}
            onCancel={() => close()}
          />
        )}
      </div>
    );
  }

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
            <Row
              label="Name"
              htmlFor="new-agent-name"
              help={nameProblem
                ? <span id="new-agent-name-error" data-testid="new-agent-name-error" className="text-ctp-error">{nameProblem}</span>
                : 'Generated. Change it now or rename it later.'}
            >
              <AgentAvatar agent={{ id: 'new', name, color, kind: 'durable', status: 'sleeping', icon: image ? 'new' : undefined } as never} size="2xs" iconUrl={image ?? undefined} />
              <input
                id="new-agent-name"
                ref={nameRef}
                data-testid="new-agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={nameProblem ? true : undefined}
                aria-describedby={nameProblem ? 'new-agent-name-error' : undefined}
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
            <Row label="Image" help={image ? undefined : 'Optional. Shown in place of the initials.'}>
              {image && <img src={image} alt="" className="w-5 h-5 rounded-full object-cover" />}
              <Button kind="ghost" data-testid="new-agent-image" onClick={pickImage} disabled={busy} className="focus-ring">{image ? 'Change…' : 'Choose…'}</Button>
              {image && <Button kind="quiet" onClick={() => setImage(null)} disabled={busy} className="focus-ring">Remove</Button>}
            </Row>
            <Rule />
            <Row
              label="Clubhouse managed"
              help={remote
                ? 'Not available yet for a project on another computer.'
                : isManaged
                  ? 'Clubhouse builds its instructions, skills, MCP servers and settings from parts you choose, and keeps them up to date. It gets its own worktree.'
                  : 'A plain agent. You manage its instructions, skills and MCP servers yourself.'}
            >
              <Toggle checked={isManaged} onChange={setManaged} disabled={remote || busy} aria-label="Clubhouse managed" />
              <span className={`text-[13px] ${remote ? 'text-ctp-overlay1' : 'text-ctp-text'}`}>Clubhouse managed</span>
            </Row>
            {!isManaged && !remote && (
              <Row
                label="Clubhouse features"
                help={clubhouseFeatures
                  ? 'Status and permission prompts. Clubhouse tools (helpers, messages, Dispatcher) are always on.'
                  : <span data-testid="new-agent-features-warning" className="text-ctp-warning">Off: Clubhouse can't show this agent's status, permission prompts or changes.</span>}
              >
                <Toggle checked={clubhouseFeatures} onChange={setClubhouseFeatures} disabled={busy} aria-label="Clubhouse features" />
                <span className="text-[13px] text-ctp-text">Clubhouse features</span>
              </Row>
            )}
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
            {quickTemplates && (
              <QuickTemplateRow
                value={quickTemplateId}
                onChange={pickQuickTemplate}
                disabled={busy}
                mcpLaunchFlags={selectedOrch?.mcpLaunchFlags === true}
                cliName={selectedOrch?.displayName ?? 'this CLI'}
              />
            )}
            <Rule />
            <Row label="Runs in" htmlFor="new-agent-runs-in" help="Or inside a durable agent’s worktree, so it works on that branch.">
              <select id="new-agent-runs-in" value={parentAgentId} onChange={(e) => setParentAgentId(e.target.value)} className={`${selectClass} w-[288px]`}>
                <option value="">Project root</option>
                {durableAgents.map((a) => <option key={a.id} value={a.id}>{a.name}’s worktree</option>)}
              </select>
            </Row>
          </>
        )}

        {!isManaged && <Row
          label="Runs on"
          htmlFor="new-agent-orchestrator"
          help={avail && !avail.available
            ? <span className="text-ctp-warning">{avail.error || 'CLI not found. The agent may fail to start.'}</span>
            : parent ? `Runs on the same CLI as ${parent.name}.` : durable ? 'The model list follows the CLI.' : undefined}
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
        </Row>}

        {durable && !isManaged && <Rule />}

        {durable && !isManaged && isGit && (
          <Row
            label="Worktree"
            help={useWorktree
              ? <>Branch <span className={mono}>{worktreeName}/standby</span> from the current branch, checked out in <span className={mono}>.clubhouse/agents/{worktreeName}</span>.</>
              : 'Works in the project folder, on whatever branch is checked out there.'}
          >
            <Toggle checked={useWorktree} onChange={setUseWorktree} aria-label="Own worktree and branch" />
            <span className="text-[13px] text-ctp-text">Own worktree and branch</span>
          </Row>
        )}

        {!isManaged && <Row
          label="Permissions"
          help={!supportsPermissions
            ? `${selectedOrch?.displayName ?? 'This CLI'} doesn't support it.`
            : durable ? 'Uses the configured Free agent permission mode. Enable only if you trust this agent with the project.' : 'Uses the configured Free agent permission mode.'}
        >
          <Toggle checked={supportsPermissions && freeAgentMode} onChange={setFreeAgentMode} disabled={!supportsPermissions} aria-label="Free Agent Mode" />
          <span className={`text-[13px] ${supportsPermissions ? 'text-ctp-text' : 'text-ctp-overlay1'}`}>Free Agent Mode</span>
        </Row>}

        {durable && !isManaged && mcpCatalog.length > 0 && (
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
          {isManaged && (
            <button type="button" data-testid="new-agent-copy" onClick={() => openStep('copy')} disabled={!canSubmit} className={footerLinkClass}>
              Copy another agent…
            </button>
          )}
          <span className="ml-auto text-xs text-ctp-overlay1">{IS_MAC ? '⌘↵' : 'Ctrl+Enter'}</span>
          <Button kind="ghost" onClick={() => close()} disabled={busy} className="focus-ring">Cancel</Button>
          {isManaged ? (
            <>
              <Button kind="ghost" data-testid="new-agent-scratch" onClick={() => openBuilder('form', SCRATCH_SEED)} disabled={!canSubmit} className="focus-ring">Build from scratch</Button>
              <Button kind="primary" type="submit" data-testid="new-agent-submit" disabled={!canSubmit} className="focus-ring">Start with template</Button>
            </>
          ) : (
            <Button kind="primary" type="submit" data-testid="new-agent-submit" disabled={!canSubmit} aria-busy={busy || undefined} className="focus-ring">
              {busy ? (durable ? 'Creating…' : 'Starting…') : durable ? 'Create' : 'Start'}
            </Button>
          )}
        </div>
      </form>
      {cropUrl && (
        <ImageCropDialog
          imageDataUrl={cropUrl}
          maskShape="circle"
          onConfirm={(url) => { setCropUrl(null); setImage(url); }}
          onCancel={() => setCropUrl(null)}
        />
      )}
    </div>
  );
}


