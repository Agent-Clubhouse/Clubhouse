import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { CLUBHOUSE_MCP_PART_ID, type ManagedAgentSetup, type ManagedPartKind, type ManagedPreview, type ManagedPartSummary } from '../../../shared/managed-agents-types';
import { BlockList, type BuilderAgent } from './BlockList';
import { LibraryPanel, PartToggleList } from './LibraryPanel';
import { PartDialog } from './PartDialog';
import { DroppedEnvNote } from './parts-ui';
import { errorText, managed, unwrap, useManagedParts } from './managedApi';

export type BuilderTab = 'instructions' | 'skills' | 'mcp' | 'preview';
export type SetupDraft = Omit<ManagedAgentSetup, 'version'>;

export type BuilderTarget =
  | { kind: 'agent'; agent: BuilderAgent }
  | { kind: 'draft'; value: SetupDraft; onChange: (next: SetupDraft) => void; agentName?: string };

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
  const agent = target.kind === 'agent' ? target.agent : undefined;
  const agentName = agent?.agentName ?? (target.kind === 'draft' ? target.agentName : undefined);

  if (!setup) {
    return <p className="text-[13px] text-ctp-overlay1 py-3">{error ?? 'Loading…'}</p>;
  }

  const update = (kind: ManagedPartKind, ids: string[]) => { void save({ ...setup, [listKey(kind)]: ids }); };
  const toggle = (kind: ManagedPartKind, id: string, on: boolean) => {
    // The Clubhouse MCP part is always on (saveSetup adds it back anyway).
    if (kind === 'mcp' && id === CLUBHOUSE_MCP_PART_ID && !on) return;
    const list = setup[listKey(kind)];
    update(kind, on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id));
  };
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
      {tab === 'preview' && !agent && <p className="text-[13px] text-ctp-overlay1">The preview appears once the agent exists.</p>}
      {dialog && (
        <PartDialog open kind={dialog.kind} editId={dialog.editId} agentName={agentName} onClose={() => setDialog(null)} onCreated={dialog.editId ? undefined : onCreated} />
      )}
    </div>
  );
}

/** What the agent gets at its next start (#2895): exact text, block boundaries, skills, MCP servers. */
export function PreviewPane({ agent, setup }: { agent: BuilderAgent; setup?: SetupDraft }) {
  const [preview, setPreview] = useState<ManagedPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(setup ?? null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void unwrap(managed().preview(agent.projectPath, agent.agentId, setup))
        .then((p) => { if (!cancelled) { setPreview(p); setError(null); } })
        .catch((err) => { /* telemetry-exempt: shown to the person */ if (!cancelled) setError(errorText(err)); });
    };
    load();
    const off = managed().onChanged(load);
    return () => { cancelled = true; off(); };
  }, [agent.projectPath, agent.agentId, key]);
  if (error) return <p role="alert" className="text-xs text-ctp-error">{error}</p>;
  if (!preview) return <p className="text-[13px] text-ctp-overlay1">Loading…</p>;
  const lines = preview.instructions.split('\n');
  return (
    <div className="flex flex-col gap-4" data-testid="managed-preview">
      <section>
        <h3 className="text-[13px] font-semibold text-ctp-text mb-1">Instructions <span className="font-normal text-xs text-ctp-overlay1">{preview.blocks.length} blocks, {preview.instructions ? lines.length : 0} lines</span></h3>
        <div className="grid grid-cols-[168px_minmax(0,1fr)] border border-surface-0 rounded-md overflow-hidden">
          <ol className="bg-ctp-mantle border-r border-surface-0 text-[11.5px] text-ctp-overlay1">
            {preview.blocks.map((b, i) => (
              <li key={`${b.id}-${i}`} className="px-2.5 py-2 border-b border-surface-0">
                <span className="block text-ctp-subtext1 font-medium">{i + 1} {b.name}</span>
                {b.builtin ? 'Built-in' : 'Custom'} · lines {b.startLine} to {b.endLine}
              </li>
            ))}
          </ol>
          <pre className="px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-ctp-text whitespace-pre-wrap break-words min-w-0" data-testid="managed-preview-text">{preview.instructions || 'No instructions.'}</pre>
        </div>
      </section>
      <div className="grid grid-cols-2 gap-6">
        <section>
          <h3 className="text-[13px] font-semibold text-ctp-text mb-1">Skills</h3>
          {preview.skills.length === 0 ? <p className="text-xs text-ctp-overlay1">None.</p> : (
            <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3.5 gap-y-1 text-xs">
              {preview.skills.map((s) => <Fragment key={s.id}><dt className="text-ctp-overlay1">{s.name}</dt><dd className="text-ctp-text font-mono truncate">{s.folder} · {s.files} file{s.files === 1 ? '' : 's'}</dd></Fragment>)}
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
