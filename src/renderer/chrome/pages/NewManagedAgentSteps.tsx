import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Agent, Project } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID, isListed, type ManagedTemplate, type ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import {
  DEFAULT_MAX_HELPERS, MAX_HELPER_LIMIT, ORCHESTRATION_DEFAULTS,
  type OrchestrationAccess, type OrchestrationControl, type OrchestrationPolicyConfig,
} from '../../../shared/orchestration-policy';
import { normalizeIdleSleep, type AgentIdleSleep } from '../../../shared/idle-sleep';
import type { AccessLevel } from '../../../shared/agent-access';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import { AccessSelect as AccessLevelSelect, accessHelp, useDefaultAccess } from '../../features/agents/AccessSelect';
import { ManagedBuilder, type SetupDraft } from '../../features/managed/ManagedBuilder';
import { managed, unwrap, useManagedTemplates } from '../../features/managed/managedApi';
import { settingsAccess } from '../../features/managed/create-managed-agent';
import {
  EffortSelect, HELPER_SELECTION_HELP, HELPER_TEMPLATE_HELP, HelperSelectionSelect, HelperTemplateSelect, IDLE_SLEEP_HELP, IdleSleepSelect,
  effortHelp, useModelEfforts,
} from '../../features/managed/settings-fields';
import { AccessSelect, ControlSelect, DISPATCHER_HELP, DispatcherToggle } from '../../features/agents/helpers/OrchestrationFields';
import { controlHelp } from '../../features/agents/helpers/helper-model';
import { useDispatcherConnection } from '../../features/dispatcher/useDispatcherEnabled';
import { useEffectiveOrchestrators } from '../../hooks/useEffectiveOrchestrators';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useAgentStore } from '../../stores/agentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';
import { IS_MAC, Row, Rule, Segmented, footerLinkClass, inputClass, selectClass, tabPanelProps } from './newAgentUi';
import { templateGrantSummary } from '../../../shared/grant-summary';

/**
 * The managed steps of New agent (#2893): Start with template, the builder
 * for an agent that doesn't exist yet, and Copy another agent. Identity
 * (project, name, color, image) stays on the page that holds these steps.
 */

/** What the builder opens with, and the subtitle's "from …" part. */
export interface BuilderSeed {
  /** Which start this is: going back and forward to the same one keeps the draft. */
  key: string;
  origin: string;
  setup: SetupDraft;
  settings: ManagedTemplateSettings;
}

// BUILTIN_BLOCK_IDS.identity in main/services/managed-agents/builtins.ts:
// the setup main gives an agent created with no parts.
const IDENTITY_BLOCK_ID = 'builtin-block-identity';

export const SCRATCH_SEED: BuilderSeed = {
  key: 'scratch',
  origin: 'from scratch',
  setup: { blocks: [IDENTITY_BLOCK_ID], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] },
  settings: {},
};

export function templateSeed(t: ManagedTemplate): BuilderSeed {
  return {
    key: `template:${t.id}`,
    origin: `from the ${t.name} template`,
    setup: { blocks: [...t.setup.blocks], skills: [...t.setup.skills], mcps: [...t.setup.mcps], templateId: t.id },
    settings: t.settings,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 blocks · 1 skill · 2 MCP servers · helpers on, up to 5". */
export function templateSummary(t: Pick<ManagedTemplate, 'setup' | 'settings'>): string {
  const parts = [
    plural(t.setup.blocks.length, 'block', 'blocks'),
    plural(t.setup.skills.length, 'skill', 'skills'),
    plural(t.setup.mcps.length, 'MCP server', 'MCP servers'),
  ];
  const o = t.settings.orchestration;
  if (o?.orchestrate) parts.push(`helpers on, up to ${o.maxHelpers ?? DEFAULT_MAX_HELPERS}`);
  return parts.join(' · ');
}

/**
 * What agents made from a template can do through Clubhouse (#2971): one
 * line, and the full list by target when expanded. From the same default
 * grants the call-time check uses.
 */
function TemplateGrants({ template }: { template: Pick<ManagedTemplate, 'id' | 'settings'> }) {
  const { line, groups } = useMemo(() => templateGrantSummary(template.settings.orchestration), [template.settings.orchestration]);
  return (
    <details className="text-xs text-ctp-overlay1 leading-normal" data-testid={`managed-template-grants-${template.id}`}>
      <summary className="cursor-pointer select-none hover:text-ctp-subtext1">{line}</summary>
      <dl className="mt-1 ml-3 flex flex-col gap-1">
        {groups.map((g) => (
          <div key={g.label}>
            <dt className="text-ctp-subtext1">{g.label}</dt>
            <dd>{g.actions.join(', ')}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** The step's heading takes focus, so a screen reader hears the new page. */
function StepHeader({ id, title, subtitle }: { id: string; title: string; subtitle: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="mb-[18px]">
      <h1 id={id} ref={ref} tabIndex={-1} className="text-lg font-semibold text-ctp-text outline-none">{title}</h1>
      <p className="mt-1 text-[13px] text-ctp-overlay1">{subtitle}</p>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" data-testid="new-agent-error" className="mt-3 text-xs leading-normal text-ctp-error">{error}</p>;
}

// ── Start with template ─────────────────────────────────────────────────────

export function TemplateStep({ name, projectName, busy, error, onCreate, onCustomize, onBack, onCancel }: {
  name: string;
  projectName: string;
  busy: boolean;
  error: string | null;
  onCreate: (t: ManagedTemplate) => void;
  onCustomize: (t: ManagedTemplate) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const templates = useManagedTemplates();
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => { if (!busy) setPending(null); }, [busy]);
  // Retired built-in templates (D71) aren't offered for new agents.
  const all = (templates.value ?? []).filter(isListed);
  const sections = [
    { title: 'Built-in', list: all.filter((t) => t.builtin), empty: 'No built-in templates.' },
    { title: 'Your templates', list: all.filter((t) => !t.builtin), empty: 'None yet. Save an agent\'s setup as a template from its General settings.' },
  ];
  return (
    <div className="w-[680px] max-w-full mx-auto px-6 pt-12 pb-10 flex flex-col" data-testid="new-agent-templates">
      <StepHeader id="new-agent-step-title" title="Start with template" subtitle={`${name} in ${projectName}. Create makes it now, or Customize to change its parts first.`} />
      {templates.error && <p role="alert" className="text-xs text-ctp-error">{templates.error}</p>}
      {!templates.value && !templates.error && <p className="text-[13px] text-ctp-overlay1">Loading…</p>}
      {templates.value && sections.map((s) => (
        <section key={s.title} aria-label={s.title} className="mb-5">
          <h2 className="text-[13px] font-semibold text-ctp-text mb-1.5">{s.title}</h2>
          {s.list.length === 0 ? <p className="text-xs text-ctp-overlay1">{s.empty}</p> : (
            <ul className="rounded-lg border border-surface-1 bg-ctp-mantle">
              {s.list.map((t, i) => (
                <li key={t.id} data-testid={`managed-template-${t.id}`} className={`flex items-start gap-3 px-3 py-2.5 ${i > 0 ? 'border-t border-surface-0' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 text-[13px]">
                      <span className="text-ctp-text font-medium truncate">{t.name}</span>
                      <span className="text-xs text-ctp-overlay1 flex-shrink-0">{t.builtin ? 'Built-in' : 'Custom'}</span>
                    </div>
                    {t.description && <div className="text-xs text-ctp-subtext0 leading-normal">{t.description}</div>}
                    <div className="text-xs text-ctp-overlay1 truncate">{templateSummary(t)}</div>
                    <TemplateGrants template={t} />
                  </div>
                  <div className="flex items-center gap-2 pt-0.5">
                    <Button kind="ghost" onClick={() => onCustomize(t)} disabled={busy} aria-label={`Customize ${t.name}`} className="focus-ring">Customize</Button>
                    <Button
                      kind="primary"
                      onClick={() => { setPending(t.id); onCreate(t); }}
                      disabled={busy}
                      aria-busy={(busy && pending === t.id) || undefined}
                      aria-label={`Create from ${t.name}`}
                      className="focus-ring"
                    >
                      {busy && pending === t.id ? 'Creating…' : 'Create'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <ErrorLine error={error} />
      <div className="mt-[18px] flex items-center gap-2">
        <button type="button" onClick={onBack} disabled={busy} className={footerLinkClass}>Back</button>
        <Button kind="ghost" onClick={onCancel} disabled={busy} className="ml-auto focus-ring">Cancel</Button>
      </div>
    </div>
  );
}

// ── Copy another agent ──────────────────────────────────────────────────────

interface CopyCandidate { agent: Agent; project: Project; setup: SetupDraft }

/** Every managed durable agent on this computer, in any project. */
function useManagedAgents(): { list: CopyCandidate[] | null } {
  const agents = useAgentStore((s) => s.agents);
  const projects = useProjectStore((s) => s.projects);
  const candidates = useMemo(() => Object.values(agents).flatMap((a) => {
    if (a.kind !== 'durable' || isRemoteProjectId(a.projectId) || a.status === 'creating') return [];
    const project = projects.find((p) => p.id === a.projectId);
    return project ? [{ agent: a, project }] : [];
  }), [agents, projects]);
  // Re-read only when the set of agents changes, not on every status update.
  const key = candidates.map((c) => `${c.project.path}:${c.agent.id}`).join('|');
  const [list, setList] = useState<CopyCandidate[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(candidates.map((c) => unwrap(managed().getSetup(c.project.path, c.agent.id))
      .then((s): CopyCandidate | null => (s ? { ...c, setup: { blocks: s.blocks, skills: s.skills, mcps: s.mcps, ...(s.templateId && { templateId: s.templateId }) } } : null))
      // telemetry-exempt: an agent whose setup can't be read is left out of the picker.
      .catch((): null => null)))
      .then((found) => {
        if (cancelled) return;
        const ok = found.filter((c): c is CopyCandidate => !!c);
        ok.sort((a, b) => (a.project.displayName || a.project.name).localeCompare(b.project.displayName || b.project.name) || a.agent.name.localeCompare(b.agent.name));
        setList(ok);
      });
    return () => { cancelled = true; };
  }, [key]);
  return { list };
}

/** What Copy another agent reads from the picked agent's durable config, besides what the agent list has. */
type CopiedSettings = Pick<ManagedTemplateSettings, 'access' | 'orchestration' | 'effort' | 'idleSleep' | 'helperTemplateId' | 'grants'>;

export function copySeed(c: { agent: Agent; setup: SetupDraft; orchestration?: OrchestrationPolicyConfig; config?: CopiedSettings }): BuilderSeed {
  const orchestration = c.config?.orchestration ?? c.orchestration;
  const access = c.config?.access ?? settingsAccess(c.agent);
  return {
    key: `copy:${c.agent.id}`,
    origin: `copied from ${c.agent.name}`,
    setup: { ...c.setup, blocks: [...c.setup.blocks], skills: [...c.setup.skills], mcps: [...c.setup.mcps] },
    settings: {
      ...(c.agent.orchestrator && { orchestrator: c.agent.orchestrator }),
      ...(c.agent.model && c.agent.model !== 'default' && { model: c.agent.model }),
      ...(access && { access }),
      ...(orchestration && { orchestration: { ...orchestration } }),
      ...(c.config?.effort && { effort: c.config.effort }),
      ...(c.config?.idleSleep && { idleSleep: c.config.idleSleep }),
      ...(c.config?.helperTemplateId && { helperTemplateId: c.config.helperTemplateId }),
      ...(c.config?.grants?.length && { grants: c.config.grants }),
    },
  };
}

/** The picked agent's orchestration policy, effort, auto-sleep and helper template live on its durable config. A failed read copies none. */
async function copiedSettingsOf(c: CopyCandidate): Promise<CopiedSettings | undefined> {
  try {
    const config = await window.clubhouse.agent.getDurableConfig(c.project.path, c.agent.id);
    if (!config) return undefined;
    // Its Clubhouse permissions over the defaults (#2971). Unreadable: copied without them.
    const grants = await window.clubhouse.agent.getGrants(c.project.path, c.agent.id).then((v) => v.carried ?? [], (): [] => []);
    return {
      ...(grants.length > 0 && { grants: grants.map((g) => ({ action: g.action, target: g.target, mode: g.mode })) }),
      ...(config.access && { access: config.access }),
      ...(config.orchestration && { orchestration: config.orchestration }),
      ...(config.effort && { effort: config.effort }),
      ...(config.idleSleep !== undefined && { idleSleep: config.idleSleep }),
      ...(config.helperTemplateId && { helperTemplateId: config.helperTemplateId }),
    };
  } catch {
    // telemetry-exempt: the builder opens with these at their defaults, which the person can see and change.
    return undefined;
  }
}

export function CopyStep({ name, onPick, onBack, onCancel }: {
  name: string;
  onPick: (seed: BuilderSeed) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const { list } = useManagedAgents();
  return (
    <div className="w-[600px] max-w-full mx-auto px-6 pt-12 pb-10 flex flex-col" data-testid="new-agent-copy">
      <StepHeader id="new-agent-step-title" title="Copy another agent" subtitle={`Opens the builder for ${name} with that agent's parts and settings. The agent you copy doesn't change.`} />
      {!list && <p className="text-[13px] text-ctp-overlay1">Loading…</p>}
      {list && list.length === 0 && <p className="text-[13px] text-ctp-overlay1">No Clubhouse managed agents yet.</p>}
      {list && list.length > 0 && (
        <ul aria-label="Managed agents" className="rounded-lg border border-surface-1 bg-ctp-mantle">
          {list.map((c, i) => (
            <li key={c.agent.id} className={i > 0 ? 'border-t border-surface-0' : ''}>
              <button
                type="button"
                onClick={() => { void copiedSettingsOf(c).then((config) => onPick(copySeed({ ...c, config }))); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left cursor-pointer hover:bg-surface-0 focus-ring rounded-lg"
              >
                <AgentAvatar agent={c.agent} size="2xs" />
                <span className="text-[13px] text-ctp-text truncate">{c.agent.name}</span>
                <span className="ml-auto text-xs text-ctp-overlay1 flex-shrink-0">{c.project.displayName || c.project.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-[18px] flex items-center gap-2">
        <button type="button" onClick={onBack} className={footerLinkClass}>Back</button>
        <Button kind="ghost" onClick={onCancel} className="ml-auto focus-ring">Cancel</Button>
      </div>
    </div>
  );
}

// ── The builder for a new agent ─────────────────────────────────────────────

type NewBuilderTab = 'instructions' | 'skills' | 'mcp' | 'settings' | 'preview';
const TABS: ReadonlyArray<{ id: NewBuilderTab; label: string }> = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'settings', label: 'Settings' },
  { id: 'preview', label: 'Preview' },
];

/** The builder's choices, held by the New agent page so Back and forward keep them. */
export interface BuilderDraft {
  /** The seed's key: forward to the same start keeps this draft, a different one replaces it. */
  key: string;
  tab: NewBuilderTab;
  setup: SetupDraft;
  /** Empty: the project's first CLI. */
  orchestrator: string;
  model: string;
  /** The agent's Access (#2761). Unset: the app's Default access. */
  agentAccess?: AccessLevel;
  orchestrate: boolean;
  helperLimit: string;
  /** Empty: the CLI's default. */
  effort: string;
  idleSleep: AgentIdleSleep;
  /** Unset: the app setting. */
  autoHelpers?: boolean;
  /** Unset: follows orchestration. */
  connectToDispatcher?: boolean;
  control?: OrchestrationControl;
  access?: OrchestrationAccess;
  /** Empty: the app's default helper template. */
  helperTemplateId: string;
}

export function draftFromSeed(seed: BuilderSeed): BuilderDraft {
  const o = seed.settings.orchestration ?? {};
  const agentAccess = settingsAccess(seed.settings);
  return {
    key: seed.key,
    tab: 'instructions',
    setup: seed.setup,
    orchestrator: seed.settings.orchestrator ?? '',
    model: seed.settings.model ?? 'default',
    ...(agentAccess && { agentAccess }),
    orchestrate: !!o.orchestrate,
    helperLimit: String(o.maxHelpers ?? DEFAULT_MAX_HELPERS),
    effort: seed.settings.effort ?? '',
    idleSleep: normalizeIdleSleep(seed.settings.idleSleep),
    ...(o.autoHelpers !== undefined && { autoHelpers: o.autoHelpers }),
    ...(o.connectToDispatcher !== undefined && { connectToDispatcher: o.connectToDispatcher }),
    ...(o.control !== undefined && { control: o.control }),
    ...(o.access !== undefined && { access: o.access }),
    helperTemplateId: seed.settings.helperTemplateId ?? '',
  };
}

/**
 * The settings Create agent sends, and Preview shows: the seed's, with what
 * this page edits taken from the draft. A setting left at its default isn't
 * sent, so the agent follows the app or the CLI.
 */
export function builderSettings(draft: BuilderDraft, seed: BuilderSeed, opts: { orchestrator: string; supportsPermissions: boolean; defaultAccess: AccessLevel; limit: number }): ManagedTemplateSettings {
  const orchestration: OrchestrationPolicyConfig = {
    ...(seed.settings.orchestration ?? {}),
    orchestrate: draft.orchestrate,
    ...(draft.orchestrate && Number.isFinite(opts.limit) && { maxHelpers: opts.limit }),
  };
  delete orchestration.autoHelpers;
  delete orchestration.connectToDispatcher;
  delete orchestration.control;
  delete orchestration.access;
  if (draft.autoHelpers !== undefined) orchestration.autoHelpers = draft.autoHelpers;
  if (draft.connectToDispatcher !== undefined) orchestration.connectToDispatcher = draft.connectToDispatcher;
  if (draft.control !== undefined) orchestration.control = draft.control;
  if (draft.access !== undefined) orchestration.access = draft.access;
  return {
    orchestrator: opts.orchestrator,
    ...(draft.model !== 'default' && { model: draft.model }),
    ...(draft.effort && { effort: draft.effort }),
    // A CLI without permission support starts at Ask first, whatever the draft says.
    access: opts.supportsPermissions ? draft.agentAccess ?? opts.defaultAccess : 'ask',
    orchestration,
    ...(draft.idleSleep !== 'inherit' && { idleSleep: draft.idleSleep }),
    ...(draft.helperTemplateId && { helperTemplateId: draft.helperTemplateId }),
    // The template's or the copied agent's Clubhouse permissions go with it (#2971).
    ...(seed.settings.grants?.length && { grants: seed.settings.grants }),
  };
}

export function BuilderStep({ name, projectName, projectPath, seed, draft, onDraftChange, busy, error, canCreate, onCreate, onBack, onCancel }: {
  name: string;
  projectName: string;
  projectPath: string;
  seed: BuilderSeed;
  draft: BuilderDraft;
  onDraftChange: (next: BuilderDraft) => void;
  busy: boolean;
  error: string | null;
  /** The name from the identity rows is usable. */
  canCreate: boolean;
  onCreate: (setup: SetupDraft, settings: ManagedTemplateSettings) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const { tab, setup, orchestrator, model, orchestrate, helperLimit, effort } = draft;
  const change = (patch: Partial<BuilderDraft>) => onDraftChange({ ...draft, ...patch });
  const setTab = (next: NewBuilderTab) => change({ tab: next });
  const tabsId = useId();
  const setSetup = (next: SetupDraft) => change({ setup: next });

  // Settings, prefilled from the template or the copied agent.
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const availability = useOrchestratorStore((s) => s.availability);
  const { effectiveOrchestrators } = useEffectiveOrchestrators();
  const resolvedOrchestrator = orchestrator || effectiveOrchestrators[0]?.id || 'claude-code';
  const { options: modelOptions, loading: modelsLoading } = useModelOptions(resolvedOrchestrator, projectPath);
  const selectedOrch = allOrchestrators.find((o) => o.id === resolvedOrchestrator);
  const supportsPermissions = selectedOrch?.capabilities?.permissions ?? false;
  const defaultAccess = useDefaultAccess();
  const agentAccess: AccessLevel = supportsPermissions ? draft.agentAccess ?? defaultAccess : 'ask';
  const avail = availability[resolvedOrchestrator];
  // Helpers go through the Clubhouse MCP server, which is in every setup.
  const orchestrating = orchestrate;
  const limit = /^\d+$/.test(helperLimit.trim()) ? Number(helperLimit.trim()) : NaN;
  const limitProblem = orchestrating && !(limit >= 1 && limit <= MAX_HELPER_LIMIT) ? `Enter a number from 1 to ${MAX_HELPER_LIMIT}.` : null;
  const cliChoices = effectiveOrchestrators.some((o) => o.id === resolvedOrchestrator)
    ? effectiveOrchestrators
    : [...effectiveOrchestrators, ...allOrchestrators.filter((o) => o.id === resolvedOrchestrator)];
  const modelChoices = !modelsLoading && model !== 'default' && !modelOptions.some((o) => o.id === model)
    ? [...modelOptions, { id: model, label: model }]
    : modelOptions;
  const { levelsFor, loading: effortsLoading } = useModelEfforts(resolvedOrchestrator, projectPath);
  const effortLevels = levelsFor(model);
  const { show: showDispatcher } = useDispatcherConnection();
  const settings = builderSettings(draft, seed, { orchestrator: resolvedOrchestrator, supportsPermissions, defaultAccess, limit });

  const create = () => {
    if (busy || !canCreate || limitProblem) return;
    onCreate(setup, settings);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // ⌘↵ creates, except while typing in a block or skill editor, or in a dialog
    // (the part dialog is drawn inside this step and has its own buttons).
    const target = e.target as HTMLElement;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && target.tagName !== 'TEXTAREA' && !target.closest('[role="dialog"]')) {
      e.preventDefault();
      create();
    }
  };
  return (
    <div className="w-[960px] max-w-full mx-auto px-6 pt-12 pb-10 flex flex-col" data-testid="new-agent-builder" onKeyDown={onKeyDown}>
      <StepHeader id="new-agent-step-title" title={`Build ${name}`} subtitle={`${projectName} · ${seed.origin} · nothing runs until you create it`} />
      <div className="mb-3">
        <Segmented<NewBuilderTab> label="Builder section" idPrefix={tabsId} value={tab} options={TABS} onChange={setTab} testIdPrefix="new-agent-builder-tab" />
      </div>
      <div {...tabPanelProps(tabsId, tab)}>
        {tab !== 'settings' && (
          <ManagedBuilder
            target={{ kind: 'draft', value: setup, onChange: setSetup, agentName: name, preview: { projectPath, settings } }}
            tab={tab}
          />
        )}
        {tab === 'settings' && (
          <div data-testid="new-agent-builder-settings" className="w-[600px] max-w-full">
            <Row
              label="Runs on"
              htmlFor="new-agent-builder-orchestrator"
              help={avail && !avail.available
                ? <span className="text-ctp-warning">{avail.error || 'CLI not found. The agent may fail to start.'}</span>
                : 'The model list follows the CLI.'}
            >
              <select
                id="new-agent-builder-orchestrator"
                value={resolvedOrchestrator}
                onChange={(e) => change({ orchestrator: e.target.value, model: 'default', effort: '' })}
                className={`${selectClass} w-40`}
              >
                {cliChoices.map((o) => {
                  const a = availability[o.id];
                  return <option key={o.id} value={o.id}>{o.displayName}{a && !a.available ? ' (not found)' : ''}</option>;
                })}
              </select>
              <select aria-label="Model" value={model} disabled={modelsLoading} onChange={(e) => change({ model: e.target.value, effort: '' })} className={`${selectClass} w-[120px]`}>
                {modelsLoading ? <option value={model}>Loading…</option> : modelChoices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Row>
            <Row label="Effort" htmlFor="new-agent-builder-effort" help={effortHelp(effortLevels, effortsLoading)}>
              <EffortSelect
                id="new-agent-builder-effort"
                value={effort}
                levels={effortLevels}
                disabled={effortsLoading || (effortLevels.length === 0 && !effort)}
                onChange={(next) => change({ effort: next })}
                className={`${selectClass} w-40`}
              />
            </Row>
            <Row label="Workspace" help="Clubhouse managed agents always get their own worktree and branch, or their own folder outside git.">
              <span className="text-[13px] text-ctp-text">Its own worktree and branch</span>
            </Row>
            <Row
              label="Access"
              htmlFor="new-agent-builder-agent-access"
              help={supportsPermissions
                ? accessHelp(agentAccess)
                : `${selectedOrch?.displayName ?? 'This CLI'} doesn't support it.`}
            >
              <AccessLevelSelect
                id="new-agent-builder-agent-access"
                value={agentAccess}
                providerId={resolvedOrchestrator}
                disabled={!supportsPermissions}
                onChange={(level) => change({ agentAccess: level })}
                className={`${selectClass} w-48 disabled:opacity-60 disabled:cursor-not-allowed`}
                data-testid="new-agent-builder-agent-access"
              />
            </Row>
            <Rule />
            <Row label="Orchestration" help={orchestrating ? 'It can start helpers and give them work.' : 'It works alone.'}>
              <Toggle checked={orchestrating} onChange={(on) => change({ orchestrate: on })} aria-label="Can start helpers" />
              <span className="text-[13px] text-ctp-text">Can start helpers</span>
            </Row>
            {orchestrating && (
              <Row
                label="Helper limit"
                htmlFor="new-agent-builder-helper-limit"
                help={limitProblem
                  ? <span id="new-agent-builder-helper-limit-error" className="text-ctp-error">{limitProblem}</span>
                  : 'The most helpers it can have at once.'}
              >
                <input
                  id="new-agent-builder-helper-limit"
                  type="number"
                  min={1}
                  max={MAX_HELPER_LIMIT}
                  value={helperLimit}
                  onChange={(e) => change({ helperLimit: e.target.value })}
                  aria-invalid={limitProblem ? true : undefined}
                  aria-describedby={limitProblem ? 'new-agent-builder-helper-limit-error' : undefined}
                  className={`${inputClass} w-20`}
                />
              </Row>
            )}
            {orchestrating && (
              <>
                <Row label="Helper selection" htmlFor="new-agent-builder-helper-selection" help={HELPER_SELECTION_HELP}>
                  <HelperSelectionSelect
                    id="new-agent-builder-helper-selection"
                    value={draft.autoHelpers}
                    onChange={(next) => change({ autoHelpers: next })}
                    className={`${selectClass} w-40`}
                  />
                </Row>
                <Row label="Helper template" htmlFor="new-agent-builder-helper-template" help={HELPER_TEMPLATE_HELP}>
                  <HelperTemplateSelect
                    id="new-agent-builder-helper-template"
                    value={draft.helperTemplateId}
                    onChange={(next) => change({ helperTemplateId: next })}
                    className={`${selectClass} w-56`}
                  />
                </Row>
                <Row label="Approvals" htmlFor="new-agent-builder-control" help={controlHelp(draft.control ?? ORCHESTRATION_DEFAULTS.control, name)}>
                  <ControlSelect
                    id="new-agent-builder-control"
                    value={draft.control ?? ORCHESTRATION_DEFAULTS.control}
                    onChange={(next) => change({ control: next })}
                    className={`${selectClass} w-48`}
                  />
                </Row>
                <Row label="Helper access" htmlFor="new-agent-builder-access" help={`Never more than ${name} has when a helper starts.`}>
                  <AccessSelect
                    id="new-agent-builder-access"
                    value={draft.access ?? ORCHESTRATION_DEFAULTS.access}
                    access={null}
                    running={false}
                    name={name}
                    onChange={(next) => change({ access: next })}
                    className={`${selectClass} w-48`}
                  />
                </Row>
              </>
            )}
            <Rule />
            {showDispatcher && (
              <Row label="Dispatcher" help={DISPATCHER_HELP}>
                <DispatcherToggle
                  checked={draft.connectToDispatcher ?? orchestrating}
                  name={name}
                  onChange={(on) => change({ connectToDispatcher: on })}
                  testId="new-agent-builder-dispatcher"
                />
                <span className="text-[13px] text-ctp-text">Connect to Dispatcher</span>
              </Row>
            )}
            <Row label="Auto-sleep" htmlFor="new-agent-builder-idle-sleep" help={IDLE_SLEEP_HELP}>
              <IdleSleepSelect
                id="new-agent-builder-idle-sleep"
                value={draft.idleSleep}
                onChange={(next) => change({ idleSleep: next })}
                className={`${selectClass} w-48`}
              />
            </Row>
            <p className="mt-2 pl-32 text-xs leading-normal text-ctp-overlay1">Instructions don't grant access. These settings do.</p>
          </div>
        )}
      </div>
      <ErrorLine error={error} />
      <div className="mt-[18px] flex items-center gap-2">
        <button type="button" onClick={onBack} disabled={busy} className={footerLinkClass}>Back</button>
        <span className="ml-auto text-xs text-ctp-overlay1">{IS_MAC ? '⌘↵' : 'Ctrl+Enter'}</span>
        <Button kind="ghost" onClick={onCancel} disabled={busy} className="focus-ring">Cancel</Button>
        <Button
          kind="primary"
          data-testid="new-agent-builder-create"
          onClick={create}
          disabled={busy || !canCreate || !!limitProblem}
          aria-busy={busy || undefined}
          className="focus-ring"
        >
          {busy ? 'Creating…' : 'Create agent'}
        </Button>
      </div>
    </div>
  );
}
