import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Agent, Project } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID, type ManagedTemplate, type ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import { DEFAULT_MAX_HELPERS, MAX_HELPER_LIMIT, type OrchestrationPolicyConfig } from '../../../shared/orchestration-policy';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import { ManagedBuilder, type SetupDraft } from '../../features/managed/ManagedBuilder';
import { managed, unwrap, useManagedTemplates } from '../../features/managed/managedApi';
import { useEffectiveOrchestrators } from '../../hooks/useEffectiveOrchestrators';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useAgentStore } from '../../stores/agentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';
import { IS_MAC, Row, Rule, Segmented, footerLinkClass, inputClass, selectClass, tabPanelProps } from './newAgentUi';

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
  const all = templates.value ?? [];
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

export function copySeed(c: { agent: Agent; setup: SetupDraft; orchestration?: OrchestrationPolicyConfig }): BuilderSeed {
  return {
    key: `copy:${c.agent.id}`,
    origin: `copied from ${c.agent.name}`,
    setup: { ...c.setup, blocks: [...c.setup.blocks], skills: [...c.setup.skills], mcps: [...c.setup.mcps] },
    settings: {
      ...(c.agent.orchestrator && { orchestrator: c.agent.orchestrator }),
      ...(c.agent.model && c.agent.model !== 'default' && { model: c.agent.model }),
      ...(c.agent.freeAgentMode && { freeAgentMode: true }),
      ...(c.orchestration && { orchestration: { ...c.orchestration } }),
    },
  };
}

/** The picked agent's orchestration policy lives on its durable config. A failed read copies none. */
async function orchestrationOf(c: CopyCandidate): Promise<OrchestrationPolicyConfig | undefined> {
  try {
    const config = await window.clubhouse.agent.getDurableConfig(c.project.path, c.agent.id);
    return config?.orchestration;
  } catch {
    // telemetry-exempt: the builder opens with orchestration off, which the person can see and change.
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
                onClick={() => { void orchestrationOf(c).then((orchestration) => onPick(copySeed({ ...c, orchestration }))); }}
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

type NewBuilderTab = 'instructions' | 'skills' | 'mcp' | 'settings';
const TABS: ReadonlyArray<{ id: NewBuilderTab; label: string }> = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'settings', label: 'Settings' },
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
  freeAgentMode: boolean;
  orchestrate: boolean;
  helperLimit: string;
}

export function draftFromSeed(seed: BuilderSeed): BuilderDraft {
  return {
    key: seed.key,
    tab: 'instructions',
    setup: seed.setup,
    orchestrator: seed.settings.orchestrator ?? '',
    model: seed.settings.model ?? 'default',
    freeAgentMode: !!seed.settings.freeAgentMode,
    orchestrate: !!seed.settings.orchestration?.orchestrate,
    helperLimit: String(seed.settings.orchestration?.maxHelpers ?? DEFAULT_MAX_HELPERS),
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
  const { tab, setup, orchestrator, model, freeAgentMode, orchestrate, helperLimit } = draft;
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

  const create = () => {
    if (busy || !canCreate || limitProblem) return;
    const orchestration: OrchestrationPolicyConfig = {
      ...(seed.settings.orchestration ?? {}),
      orchestrate: orchestrating,
      ...(orchestrating && { maxHelpers: limit }),
    };
    onCreate(setup, {
      orchestrator: resolvedOrchestrator,
      ...(model !== 'default' && { model }),
      freeAgentMode: supportsPermissions && freeAgentMode,
      orchestration,
    });
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
        {tab !== 'settings' && <ManagedBuilder target={{ kind: 'draft', value: setup, onChange: setSetup, agentName: name }} tab={tab} />}
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
                onChange={(e) => change({ orchestrator: e.target.value, model: 'default' })}
                className={`${selectClass} w-40`}
              >
                {cliChoices.map((o) => {
                  const a = availability[o.id];
                  return <option key={o.id} value={o.id}>{o.displayName}{a && !a.available ? ' (not found)' : ''}</option>;
                })}
              </select>
              <select aria-label="Model" value={model} disabled={modelsLoading} onChange={(e) => change({ model: e.target.value })} className={`${selectClass} w-[120px]`}>
                {modelsLoading ? <option value={model}>Loading…</option> : modelChoices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Row>
            <Row
              label="Permissions"
              help={supportsPermissions
                ? 'Uses the configured Free agent permission mode. Enable only if you trust this agent with the project.'
                : `${selectedOrch?.displayName ?? 'This CLI'} doesn't support it.`}
            >
              <Toggle checked={supportsPermissions && freeAgentMode} onChange={(on) => change({ freeAgentMode: on })} disabled={!supportsPermissions} aria-label="Free Agent Mode" />
              <span className={`text-[13px] ${supportsPermissions ? 'text-ctp-text' : 'text-ctp-overlay1'}`}>Free Agent Mode</span>
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
