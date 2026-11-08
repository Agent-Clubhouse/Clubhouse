import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  CLUBHOUSE_MCP_PART_ID,
  findSkillFolderClash,
  skillFolderClashMessage,
  type ManagedAgentSetup,
  type ManagedPartKind,
  type ManagedPartSummary,
  type ManagedPreview,
  type ManagedSettingsRow,
  type ManagedTemplateSettings,
} from '../../../shared/managed-agents-types';
import { Toggle } from '../../components/Toggle';
import { BlockList, type BuilderAgent } from './BlockList';
import { LibraryPanel, PartToggleList } from './LibraryPanel';
import { PartDialog } from './PartDialog';
import { DroppedEnvNote } from './parts-ui';
import { errorText, managed, unwrap, useManagedParts } from './managedApi';

export type BuilderTab = 'instructions' | 'skills' | 'mcp' | 'preview';
export type SetupDraft = Omit<ManagedAgentSetup, 'version'>;

export type BuilderTarget =
  | { kind: 'agent'; agent: BuilderAgent }
  | {
    kind: 'draft';
    value: SetupDraft;
    onChange: (next: SetupDraft) => void;
    agentName?: string;
    /** New agent: the project and settings Preview renders the draft with. */
    preview?: { projectPath: string; settings: ManagedTemplateSettings };
  };

/**
 * The agent's setup, loaded and saved per change, or a draft held by the caller.
 * Loads follow the agent's ids, not the target object, so a parent's render
 * doesn't reload it. Every load and save takes a sequence number, and a load
 * that started before the latest save is dropped, so it can't put back an
 * older setup over a newer edit.
 */
export function useBuilderSetup(target: BuilderTarget): { setup: SetupDraft | null; save: (next: SetupDraft) => Promise<void>; error: string | null; reload: () => void } {
  const [loaded, setLoaded] = useState<SetupDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectPath = target.kind === 'agent' ? target.agent.projectPath : undefined;
  const agentId = target.kind === 'agent' ? target.agent.agentId : undefined;
  const seq = useRef(0);
  const reload = useCallback(() => {
    if (!projectPath || !agentId) return;
    const mine = ++seq.current;
    void unwrap(managed().getSetup(projectPath, agentId))
      .then((s) => {
        if (mine !== seq.current) return;
        setLoaded(s ? { blocks: s.blocks, skills: s.skills, mcps: s.mcps, ...(s.templateId && { templateId: s.templateId }) } : null);
        setError(null);
      })
      .catch((err) => { /* telemetry-exempt: shown to the person */ if (mine === seq.current) setError(errorText(err)); });
  }, [projectPath, agentId]);
  useEffect(() => {
    if (!projectPath || !agentId) return;
    setLoaded(null);
    reload();
    const off = managed().onChanged(reload);
    return () => { seq.current++; off(); };
  }, [reload, projectPath, agentId]);
  const save = useCallback(async (next: SetupDraft) => {
    if (!projectPath || !agentId) return;
    // Loads already under way read the setup from before this save.
    seq.current++;
    setLoaded(next);
    try {
      await unwrap(managed().saveSetup(projectPath, agentId, next));
      // And so may a load that started while it was saving.
      seq.current++;
      setError(null);
    } catch (err) {
      // telemetry-exempt: shown to the person, and the saved setup is reloaded.
      setError(errorText(err));
      reload();
    }
  }, [projectPath, agentId, reload]);
  if (target.kind === 'draft') {
    return { setup: target.value, save: async (next) => target.onChange(next), error: null, reload: () => {} };
  }
  return { setup: loaded, error, reload, save };
}

/** The skills among `ids` that the library knows, with the folder each installs to. */
function skillsIn(ids: string[], parts: ManagedPartSummary[]): Array<{ name: string; skillName: string }> {
  return ids.flatMap((id) => {
    const p = parts.find((x) => x.id === id);
    return p?.skillName ? [{ name: p.name, skillName: p.skillName }] : [];
  });
}

const listKey = (kind: ManagedPartKind): 'blocks' | 'skills' | 'mcps' => (kind === 'block' ? 'blocks' : kind === 'skill' ? 'skills' : 'mcps');

/**
 * The builder (#2895): instruction blocks with the library beside them,
 * skills and MCP servers as switches, and the exact result an agent gets.
 * Used on New agent, on an existing managed agent's settings pages, and for
 * templates.
 */
export function ManagedBuilder({ target, tab }: { target: BuilderTarget; tab: BuilderTab }) {
  const { setup, save, error } = useBuilderSetup(target);
  const blocks = useManagedParts('block');
  const skills = useManagedParts('skill');
  const mcps = useManagedParts('mcp');
  const [dialog, setDialog] = useState<{ kind: ManagedPartKind; editId?: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; seq: number } | undefined>(undefined);
  const [skillClash, setSkillClash] = useState<string | null>(null);
  const agent = target.kind === 'agent' ? target.agent : undefined;
  const agentName = agent?.agentName ?? (target.kind === 'draft' ? target.agentName : undefined);

  if (!setup) {
    return <p className="text-[13px] text-ctp-overlay1 py-3">{error ?? 'Loading…'}</p>;
  }

  const update = (kind: ManagedPartKind, ids: string[]) => { void save({ ...setup, [listKey(kind)]: ids }); };
  const skillParts = skills.value ?? [];
  const toggle = (kind: ManagedPartKind, id: string, on: boolean) => {
    // The Clubhouse MCP part is always on (saveSetup adds it back anyway).
    if (kind === 'mcp' && id === CLUBHOUSE_MCP_PART_ID && !on) return;
    const list = setup[listKey(kind)];
    if (kind === 'skill') {
      setSkillClash(null);
      if (on && !list.includes(id)) {
        const part = skillParts.find((p) => p.id === id);
        // A fork takes the place of the part it came from: a swap, not a clash with it.
        const next = part?.forkedFrom && list.includes(part.forkedFrom) ? list.map((x) => (x === part.forkedFrom ? id : x)) : [...list, id];
        // Two skills that install to one folder: say so, and let the person pick (never pick one for them).
        const clash = findSkillFolderClash(skillsIn(next, skillParts));
        if (clash) { setSkillClash(skillFolderClashMessage(clash.a, clash.b, clash.folder)); return; }
        update(kind, next);
        return;
      }
    }
    update(kind, on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id));
  };
  // A setup saved with a clash (before this check) says so too.
  const savedClash = findSkillFolderClash(skillsIn(setup.skills, skillParts));
  const skillWarning = skillClash ?? (savedClash && skillFolderClashMessage(savedClash.a, savedClash.b, savedClash.folder));
  const fork = async (kind: ManagedPartKind, id: string): Promise<string | undefined> => {
    setActionError(null);
    try {
      if (agent) {
        const copy = await unwrap(managed().forkPart(id, { projectPath: agent.projectPath, agentId: agent.agentId }));
        return copy.id;
      }
      const copy = await unwrap(managed().forkPart(id));
      const list = setup[listKey(kind)];
      update(kind, list.includes(id) ? list.map((x) => (x === id ? copy.id : x)) : [...list, copy.id]);
      return copy.id;
    } catch (err) {
      // telemetry-exempt: shown to the person above the builder.
      setActionError(errorText(err));
      return undefined;
    }
  };
  const backToShared = async (id: string) => {
    if (!agent) return;
    try { await unwrap(managed().backToShared(agent.projectPath, agent.agentId, id)); }
    catch (err) { /* telemetry-exempt: shown to the person above the builder */ setActionError(errorText(err)); }
  };
  const onCreated = (part: ManagedPartSummary) => {
    const list = setup[listKey(part.kind)];
    if (!list.includes(part.id)) update(part.kind, [...list, part.id]);
  };

  return (
    <div data-testid={`managed-builder-${tab}`} className="flex flex-col gap-3">
      {(error || actionError) && <p role="alert" className="text-xs text-ctp-error">{error ?? actionError}</p>}
      {tab === 'instructions' && (
        <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-5 items-start">
          <BlockList
            blocks={setup.blocks}
            parts={blocks.value ?? []}
            agent={agent}
            onChange={(ids) => update('block', ids)}
            onFork={(id) => fork('block', id)}
            onBackToShared={agent ? backToShared : undefined}
            onWrite={() => setDialog({ kind: 'block' })}
            notice={notice}
          />
          <LibraryPanel
            parts={blocks.value ?? []}
            inUse={setup.blocks}
            onAdd={(id) => {
              update('block', [...setup.blocks, id]);
              const name = blocks.value?.find((p) => p.id === id)?.name ?? 'Block';
              setNotice((n) => ({ text: `${name} added.`, seq: (n?.seq ?? 0) + 1 }));
            }}
            onNew={() => setDialog({ kind: 'block' })}
          />
        </div>
      )}
      {tab === 'skills' && skillWarning && <p role="alert" className="text-xs text-ctp-warning" data-testid="managed-skill-clash">{skillWarning}</p>}
      {tab === 'skills' && (
        <PartToggleList
          kind="skill"
          parts={skills.value ?? []}
          selected={setup.skills}
          agent={agent}
          note={`${setup.skills.length} on · copied into ${agentName ?? 'the agent'}'s folder at its next start`}
          onToggle={(id, on) => toggle('skill', id, on)}
          onFork={(id) => void fork('skill', id)}
          onEdit={(id) => setDialog({ kind: 'skill', editId: id })}
          onNew={() => setDialog({ kind: 'skill' })}
        />
      )}
      {tab === 'mcp' && (
        <PartToggleList
          kind="mcp"
          parts={mcps.value ?? []}
          selected={setup.mcps}
          agent={agent}
          note="Sign-in comes from your environment. Clubhouse stores no secrets."
          onToggle={(id, on) => toggle('mcp', id, on)}
          onFork={(id) => void fork('mcp', id)}
          onEdit={(id) => setDialog({ kind: 'mcp', editId: id })}
          onNew={() => setDialog({ kind: 'mcp' })}
        />
      )}
      {tab === 'preview' && agent && <PreviewPane agent={agent} setup={target.kind === 'draft' ? setup : undefined} />}
      {tab === 'preview' && !agent && target.kind === 'draft' && target.preview && (
        <PreviewPane draft={{ projectPath: target.preview.projectPath, name: agentName ?? '', setup, settings: target.preview.settings }} />
      )}
      {tab === 'preview' && !agent && !(target.kind === 'draft' && target.preview) && <p className="text-[13px] text-ctp-overlay1">The preview appears once the agent exists.</p>}
      {dialog && (
        <PartDialog open kind={dialog.kind} editId={dialog.editId} agentName={agentName} onClose={() => setDialog(null)} onCreated={dialog.editId ? undefined : onCreated} />
      )}
    </div>
  );
}

/** A New agent that doesn't exist yet: the project it goes in, the name typed, its setup and settings. */
export interface PreviewDraft {
  projectPath: string;
  name: string;
  setup: SetupDraft;
  settings: ManagedTemplateSettings;
}

/**
 * What the agent gets at its next start (#2895): exact text, block
 * boundaries, skills, MCP servers and a settings summary. A New agent draft
 * renders the same way delivery does, with the name typed and the folder
 * Clubhouse would give it. While a running agent waits on changes, "Running
 * now" shows what its session started with.
 */
export function PreviewPane({ agent, setup, draft }: { agent?: BuilderAgent; setup?: SetupDraft; draft?: PreviewDraft }) {
  const [preview, setPreview] = useState<ManagedPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWildcards, setShowWildcards] = useState(false);
  const key = JSON.stringify(draft ?? setup ?? null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const request = draft
        ? managed().previewDraft(draft.projectPath, { name: draft.name, setup: { blocks: draft.setup.blocks, skills: draft.setup.skills, mcps: draft.setup.mcps }, settings: draft.settings })
        : agent ? managed().preview(agent.projectPath, agent.agentId, setup) : null;
      if (!request) return;
      void unwrap(request)
        .then((p) => { if (!cancelled) { setPreview(p); setError(null); } })
        .catch((err) => { /* telemetry-exempt: shown to the person */ if (!cancelled) setError(errorText(err)); });
    };
    load();
    const off = managed().onChanged(load);
    return () => { cancelled = true; off(); };
  }, [agent?.projectPath, agent?.agentId, key]);
  if (error) return <p role="alert" className="text-xs text-ctp-error">{error}</p>;
  if (!preview) return <p className="text-[13px] text-ctp-overlay1">Loading…</p>;
  const text = showWildcards ? preview.rawInstructions ?? preview.instructions : preview.instructions;
  const lines = preview.instructions.split('\n');
  const running = preview.running;
  const runningText = running ? (showWildcards ? running.rawInstructions : running.instructions) : '';
  return (
    <div className="flex flex-col gap-4" data-testid="managed-preview">
      <section>
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-[13px] font-semibold text-ctp-text">Instructions <span className="font-normal text-xs text-ctp-overlay1">{preview.blocks.length} blocks, {preview.instructions ? lines.length : 0} lines</span></h3>
          <label className="ml-auto flex items-center gap-2 text-xs text-ctp-subtext1">
            <Toggle checked={showWildcards} onChange={setShowWildcards} aria-label="Show wildcards" data-testid="managed-preview-show-wildcards" />
            Show wildcards
          </label>
        </div>
        <div className={`grid ${running ? 'grid-cols-[168px_minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-[168px_minmax(0,1fr)]'} border border-surface-0 rounded-md overflow-hidden`}>
          <ol className="bg-ctp-mantle border-r border-surface-0 text-[11.5px] text-ctp-overlay1">
            {preview.blocks.map((b, i) => (
              <li key={`${b.id}-${i}`} className="px-2.5 py-2 border-b border-surface-0">
                <span className="block text-ctp-subtext1 font-medium">{i + 1} {b.name}</span>
                {b.builtin ? 'Built-in' : 'Custom'} · lines {b.startLine} to {b.endLine}
              </li>
            ))}
          </ol>
          <div className="min-w-0">
            {running && <div className="px-3 pt-2 text-xs font-medium text-ctp-subtext1">Next start</div>}
            <pre className="px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-ctp-text whitespace-pre-wrap break-words min-w-0" data-testid="managed-preview-text">{text || 'No instructions.'}</pre>
          </div>
          {running && (
            <div className="min-w-0 border-l border-surface-0" data-testid="managed-preview-running">
              <div className="px-3 pt-2 text-xs font-medium text-ctp-subtext1">Running now</div>
              <pre className="px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-ctp-subtext0 whitespace-pre-wrap break-words min-w-0" data-testid="managed-preview-running-text">{runningText || 'No instructions.'}</pre>
            </div>
          )}
        </div>
        {running && (
          <div className="mt-2 text-xs text-ctp-overlay1" data-testid="managed-preview-running-changes">
            <p>Its session started on the setup on the right. What differs:</p>
            <ul className="mt-0.5 list-disc pl-5 text-ctp-text">
              {running.changes.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <p className="mt-0.5">Restart it to use the next start.</p>
          </div>
        )}
      </section>
      {preview.settings && preview.settings.length > 0 && <SettingsSummary rows={preview.settings} running={running?.settings} />}
      <div className="grid grid-cols-2 gap-6">
        <section>
          <h3 className="text-[13px] font-semibold text-ctp-text mb-1">Skills</h3>
          {preview.skills.length === 0 ? <p className="text-xs text-ctp-overlay1">None.</p> : (
            <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3.5 gap-y-1 text-xs">
              {preview.skills.map((s) => (
                <Fragment key={s.id}>
                  <dt className="text-ctp-overlay1">{s.name}</dt>
                  {s.projectOwn
                    ? <dd className="text-ctp-text truncate" data-testid={`managed-preview-project-own-${s.id}`}>{s.projectOwn}</dd>
                    : <dd className="text-ctp-text font-mono truncate">{s.folder} · {s.files} file{s.files === 1 ? '' : 's'}</dd>}
                </Fragment>
              ))}
            </dl>
          )}
        </section>
        <section>
          <h3 className="text-[13px] font-semibold text-ctp-text mb-1">MCP servers</h3>
          {preview.mcps.length === 0 ? <p className="text-xs text-ctp-overlay1">None.</p> : (
            <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3.5 gap-y-1 text-xs">
              {preview.mcps.map((m) => (
                <Fragment key={m.id}>
                  <dt className="text-ctp-overlay1">{m.name}</dt>
                  <dd className="text-ctp-text">
                    {m.builtin ? 'Built-in' : 'Custom'} · {m.serverKey}
                    <DroppedEnvNote names={m.droppedEnvValues} testId={`managed-preview-dropped-env-${m.id}`} className="mt-0.5" />
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
        </section>
      </div>
      {preview.missing.length > 0 && <p className="text-xs text-ctp-warning">{preview.missing.length} part{preview.missing.length === 1 ? '' : 's'} in this setup no longer exist and are skipped.</p>}
      <OutsideTheSetup preview={preview} />
    </div>
  );
}

/** The settings that aren't parts. With "Running now", rows that differ show both values. */
function SettingsSummary({ rows, running }: { rows: ManagedSettingsRow[]; running?: ManagedSettingsRow[] }) {
  const was = new Map((running ?? []).map((r) => [r.key, r.value]));
  return (
    <section>
      <h3 className="text-[13px] font-semibold text-ctp-text mb-1">Settings</h3>
      <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3.5 gap-y-1 text-xs" data-testid="managed-preview-settings">
        {rows.map((r) => {
          const before = running ? was.get(r.key) : undefined;
          const differs = running !== undefined && before !== r.value;
          return (
            <Fragment key={r.key}>
              <dt className="text-ctp-overlay1">{r.label}</dt>
              <dd className="text-ctp-text" data-testid={`managed-preview-setting-${r.key}`}>
                {r.value}
                {differs && <span className="text-ctp-overlay1">{` (running now: ${before ?? 'not shown'})`}</span>}
              </dd>
            </Fragment>
          );
        })}
      </dl>
    </section>
  );
}

/** What the CLI reads besides the setup: files Clubhouse can't move or turn off, and the ones it turned off. */
function OutsideTheSetup({ preview }: { preview: ManagedPreview }) {
  const cli = preview.cliName ?? 'the CLI';
  const list = (paths: string[], testId: string, prefix = '') => (
    <ul className="flex flex-col gap-0.5 text-xs font-mono text-ctp-text" data-testid={testId}>
      {paths.map((p) => <li key={p} className="truncate">{prefix}{p}</li>)}
    </ul>
  );
  return (
    <>
      {preview.repoSkills && preview.repoSkills.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold text-ctp-text mb-1">Also loaded from the repo</h3>
          <p className="text-xs text-ctp-overlay1 mb-1">Git tracks these skill folders, so Clubhouse leaves them in place and {cli} loads them too.</p>
          {list(preview.repoSkills, 'managed-preview-repo-skills')}
        </section>
      )}
      {preview.keptSkills && preview.keptSkills.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold text-ctp-text mb-1">Also loaded</h3>
          <p className="text-xs text-ctp-overlay1 mb-1">
            {preview.keptSkillsReason === 'link'
              ? `The skills folder links to somewhere outside this agent's folder, so Clubhouse moves nothing out of it and ${cli} loads these too.`
              : `Clubhouse couldn't ask git which of these it tracks, so it leaves them in place and ${cli} loads them too.`}
          </p>
          {list(preview.keptSkills, 'managed-preview-kept-skills')}
        </section>
      )}
      {preview.alsoRead && preview.alsoRead.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold text-ctp-text mb-1">Also read by {cli}</h3>
          <p className="text-xs text-ctp-overlay1 mb-1">{cli} reads these instruction files as well. Clubhouse can't turn them off.</p>
          {list(preview.alsoRead, 'managed-preview-also-read')}
        </section>
      )}
      {preview.notRead && preview.notRead.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold text-ctp-text mb-1">Instruction files above its folder</h3>
          <p className="text-xs text-ctp-overlay1 mb-1">{cli} would read these too. Clubhouse tells it not to.</p>
          {list(preview.notRead, 'managed-preview-not-read', 'Not read: ')}
        </section>
      )}
    </>
  );
}
