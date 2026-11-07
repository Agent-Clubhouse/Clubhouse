import { useEffect, useRef, useState } from 'react';
import type { BuilderCommand, BuilderView } from '../../../shared/agent-builder-types';
import type { SkillAssetPayload } from '../../../shared/asset-catalog-types';
import type { SkillBundleDocument, SkillBundleSummary } from '../../../shared/skill-bundle-editor-types';
import { Button } from '../../components/Button';
import { SkillBundleEditor } from '../skills/SkillBundleEditor';
import { inputClass, selectClass, SectionHeading } from './agentSettingsUi';

/** Local-user catalog selection. Creation/copy and assignment are separate writes. */
export function AgentBuilderSkills({ projectId, projectPath, agentId, view, suspended, onSaved, onPreview, onDirtyChange, onBusyChange }: {
  projectId: string; projectPath: string; agentId: string; view: BuilderView; suspended: boolean;
  onSaved: (view: BuilderView) => void; onPreview: (view: BuilderView | null) => void;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const context = { projectId, agentId };
  const bridge = window.clubhouse.catalogSkillBundles;
  const [catalog, setCatalog] = useState<SkillBundleSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [document, setDocument] = useState<SkillBundleDocument | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'library' | 'project' | 'agent'>('agent');
  const [payload, setPayload] = useState<SkillAssetPayload>({ skillName: '', files: [{ path: 'SKILL.md', content: '' }] });
  const [review, setReview] = useState<{ action: BuilderCommand; view: BuilderView } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = useRef('');
  const identity = JSON.stringify([projectId, agentId, view.revision]); current.current = identity;
  const sequence = useRef(0);
  const operation = useRef(false);
  const suspendedRef = useRef(suspended); suspendedRef.current = suspended;
  const mounted = useRef(true);
  const dirty = creating || !!review;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    mounted.current = true;
    const id = ++sequence.current;
    setCatalog([]); setDocument(null); setSelected(''); setReview(null); onPreview(null);
    bridge.list(context).then((result) => {
      if (!mounted.current || sequence.current !== id || current.current !== identity) return;
      if (result.ok === true) setCatalog(result.value); else setError('Could not load catalog skills. Reload skills.');
    }).catch(() => {
      // telemetry-exempt: fixed visible failure; payloads and transport errors stay local.
      if (mounted.current && sequence.current === id) setError('Could not load catalog skills. Reload skills.');
    });
    return () => { mounted.current = false; sequence.current++; onBusyChange(false); };
  }, [identity, bridge]);
  async function perform(run: () => Promise<void>) {
    if (operation.current || suspendedRef.current || !mounted.current || current.current !== identity) return;
    sequence.current++;
    operation.current = true; setBusy(true); onBusyChange(true); setError('');
    try { await run(); }
    catch {
      // telemetry-exempt: catalog payloads and raw IPC errors never enter telemetry.
      if (mounted.current && current.current === identity) setError('The catalog operation failed. Reload before retrying. No provider loading is verified.');
    } finally {
      operation.current = false;
      if (mounted.current) { setBusy(false); onBusyChange(false); }
    }
  }
  const valid = () => mounted.current && current.current === identity;
  async function load(assetId: string) {
    if (operation.current || suspendedRef.current || !valid()) return;
    setSelected(assetId); setDocument(null); setReview(null); onPreview(null);
    await perform(async () => {
      const result = await bridge.read(context, assetId);
      if (!valid()) return;
      if (result.ok === true) setDocument(result.value); else setError('This skill is unavailable. Reload skills.');
    });
  }
  async function preview(action: BuilderCommand) {
    await perform(async () => {
      const result = await window.clubhouse.agentSettings.builderCommand(projectPath, agentId, view.revision, action);
      if (!valid()) return;
      if (result.ok === false) { setError(result.code === 'unsupported' ? 'MCP or native subagent composition is unsupported in Builder. No reference change was saved or loaded.' : result.code === 'stale' ? 'The source or Builder changed. Reload before reviewing again.' : 'This composition is blocked. Check skill names and ownership, then reload.'); return; }
      setReview({ action, view: result.view }); onPreview(result.view);
    });
  }
  const locked = suspended || busy;
  const displayed = review?.view ?? view;
  return <section aria-label="Builder skills" className="space-y-3 border-t border-surface-0 mt-4 pt-3">
    <SectionHeading title="Skills" />
    <p>Copies retain the skill directory name. Remove an existing reference to that directory before assigning its copy.</p>
    <p>Saved references only. Skills are not loaded by saving here; provider loading remains unverified. MCP and native subagent configuration are unavailable in this workflow.</p>
    {error && <p role="alert" className="text-ctp-error">{error}</p>}
    <p role="status">{busy ? 'Working with catalog skills…' : notice}</p>
    <ul aria-label="Desired skills" className="space-y-2">
      {(displayed.skills ?? []).map((skill) => <li key={skill.assetId}>
        <p>{skill.name} — {skill.payload.skillName}, revision {skill.revision}. Owner: {skill.owner.kind}. Source: {skill.source.kind}.</p>
        {skill.source.kind === 'copy' && <p>Independent copy of {skill.source.originAssetId} at revision {skill.source.originRevision}.</p>}
        <p className="text-xs break-all">Content hash: {skill.contentHash}. References: {skill.provenance.map((p) => p.via).join(', ')}.</p>
        <details><summary>Complete saved bundle: {skill.payload.files.length} files</summary>
          <SkillBundleEditor value={skill.payload} onChange={() => {}} readOnly />
        </details>
        <Button disabled={locked || dirty} onClick={() => void preview({ type: 'removeSkill', assetId: skill.assetId, confirm: false })}>Remove reference to {skill.name}</Button>
      </li>)}
    </ul>
    {(displayed.excludedSkills ?? []).map((skill) => <p key={skill.assetId}>Excluded template skill: {skill.name}. Select it below to restore its reference.</p>)}
    {!creating && !review && <>
      <label htmlFor="builder-catalog-skill">Catalog skill</label>
      <select id="builder-catalog-skill" value={selected} disabled={locked} className={selectClass} onChange={(event) => void load(event.target.value)}>
        <option value="">Choose a catalog skill</option>
        {catalog.map((skill) => <option key={skill.assetId} value={skill.assetId}>{skill.name} ({skill.owner.kind}, revision {skill.revision})</option>)}
      </select>
      <Button disabled={locked} onClick={() => void perform(async () => {
        const result = await bridge.list(context);
        if (valid()) { if (result.ok === true) { setCatalog(result.value); setSelected(''); setDocument(null); } else setError('Could not load catalog skills.'); }
      })}>Reload skills</Button>
      <Button disabled={locked} onClick={() => { setCreating(true); setDocument(null); }}>Create skill bundle</Button>
      {document && <div className="space-y-2">
        <p>{document.name}, revision {document.revision}. Owner: {document.owner.kind}. Source: {document.source.kind}. Review the complete bundle before selecting it.</p>
        <SkillBundleEditor key={document.assetId} value={document.payload} onChange={() => {}} readOnly />
        <Button disabled={locked} onClick={() => void preview({ type: 'skill', assetId: document.assetId, expectedRevision: document.revision, confirm: false })}>{document.owner.kind === 'agent' ? 'Review assignment' : 'Use shared'}</Button>
        <Button disabled={locked} onClick={() => void perform(async () => {
          const result = await bridge.copy({ context, assetId: document.assetId, expectedRevision: document.revision });
          if (!valid()) return;
          if (result.ok === false) { setError('Could not copy this exact revision. Reload skills.'); return; }
          setCatalog((items) => [...items, result.value]); setSelected(result.value.assetId); setDocument(result.value);
          setNotice('Independent copy saved, unassigned. Review and assign it explicitly.');
        })}>Make copy</Button>
      </div>}
    </>}
    {creating && <div className="space-y-2">
      <label className="block">Catalog name<input aria-label="Catalog name" className={inputClass} value={name} disabled={locked} onChange={(e) => setName(e.target.value)} /></label>
      <label className="block">Skill directory name<input aria-label="Skill directory name" className={inputClass} value={payload.skillName} disabled={locked} onChange={(e) => setPayload({ ...payload, skillName: e.target.value })} /></label>
      <label>Save scope<select aria-label="Save scope" className={selectClass} value={scope} disabled={locked} onChange={(e) => setScope(e.target.value as typeof scope)}>
        <option value="agent">This agent</option><option value="project">This project</option><option value="library">Library</option>
      </select></label>
      <SkillBundleEditor value={payload} onChange={(next) => { if (valid() && !operation.current && !suspendedRef.current) setPayload(next); }} disabled={locked} />
      <Button disabled={locked || !name.trim() || !payload.skillName} onClick={() => void perform(async () => {
        const result = await bridge.create({ context, name: name.trim(), scope, payload });
        if (!valid()) return;
        if (result.ok === false) { setError('Could not create a valid complete bundle. Check names, paths, encoding and size.'); return; }
        setCreating(false); setName(''); setPayload({ skillName: '', files: [{ path: 'SKILL.md', content: '' }] });
        setCatalog((items) => [...items, result.value]); setSelected(result.value.assetId); setDocument(result.value);
        setNotice('Bundle saved, unassigned. Review and assign it explicitly.');
      })}>Save unassigned bundle</Button>
      <Button disabled={locked} onClick={() => setCreating(false)}>Cancel creation</Button>
    </div>}
    {review && <div className="space-y-2">
      <p>Review the exact desired skills and instruction preview before saving this reference change. Assets and other consumers stay intact.</p>
      <Button disabled={locked} onClick={() => void perform(async () => {
        const action = { ...review.action, confirm: true, fingerprint: review.view.skillFingerprint } as BuilderCommand;
        const result = await window.clubhouse.agentSettings.builderCommand(projectPath, agentId, view.revision, action);
        if (!valid()) return;
        if (result.ok === false) { setReview(null); onPreview(null); setError(result.code === 'unsupported' ? 'MCP or native subagent composition is unsupported in Builder. No reference change was saved or loaded.' : 'The source or composition changed, or saving failed. Reload before retrying.'); return; }
        setReview(null); onPreview(null); setNotice('Skill references saved in Builder only. Provider loading is unverified.'); onSaved(result.view);
      })}>Save skill references</Button>
      <Button disabled={locked} onClick={() => { setReview(null); onPreview(null); }}>Cancel reference change</Button>
    </div>}
  </section>;
}
