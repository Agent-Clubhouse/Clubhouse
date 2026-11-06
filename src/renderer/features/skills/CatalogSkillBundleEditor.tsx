import { useEffect, useRef, useState } from 'react';
import type { SkillAssetPayload } from '../../../shared/asset-catalog-types';
import type { SkillBundleContext, SkillBundleDocument, SkillBundleEditPreview, SkillBundleEditorBridge, SkillBundleErrorCode } from '../../../shared/skill-bundle-editor-types';
import { Button } from '../../components/Button';
import { SkillBundleEditor } from './SkillBundleEditor';

const messages: Record<SkillBundleErrorCode, string> = {
  local_user_only: 'Open this editor in the local app.', invalid_request: 'The bundle request is invalid. Reload the editor.',
  target_changed: 'The project or agent changed. Reload before saving.', not_found: 'This catalog skill is unavailable in this context.',
  read_only: 'Built-in catalog skills are read-only.', stale_revision: 'A newer revision was saved. Reload before editing again.',
  stale_preview: 'The preview is out of date. Review the bundle again.', shared_edit_blocked: 'This bundle has consumers. Shared edits are blocked in this editor.',
  invalid_payload: 'The complete bundle is invalid. Check its paths, encoding and size.', save_failed: 'The catalog operation failed. Your unsaved edits remain here.',
};

/** Integration seam only: the caller supplies a catalog asset ID and registered context. */
export function CatalogSkillBundleEditor({ context, assetId, bridge = window.clubhouse.catalogSkillBundles, onDirtyChange }: {
  context: SkillBundleContext; assetId: string; bridge?: SkillBundleEditorBridge; onDirtyChange?: (dirty: boolean) => void;
}) {
  const target = JSON.stringify([context.projectId, context.agentId, assetId]);
  const currentTarget = useRef(target); currentTarget.current = target;
  const sequence = useRef(0);
  const busyRef = useRef(false);
  const [document, setDocument] = useState<SkillBundleDocument | null>(null);
  const [draft, setDraft] = useState<SkillAssetPayload | null>(null);
  const [preview, setPreview] = useState<SkillBundleEditPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedTarget, setLoadedTarget] = useState('');
  const dirty = !!document && JSON.stringify(document.payload) !== JSON.stringify(draft);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const valid = (id: number) => currentTarget.current === target && sequence.current === id;
  const read = async () => {
    const id = ++sequence.current;
    busyRef.current = true; setBusy(true); setPreview(null); setError(null);
    try {
      const result = await bridge.read(context, assetId);
      if (!valid(id)) return;
      if (result.ok === false) { setError(messages[result.code]); return; }
      setDocument(result.value); setDraft(result.value.payload); setLoadedTarget(target);
    } catch {
      // telemetry-exempt: raw transport errors and bundle contents stay out of logs.
      if (valid(id)) setError(messages.save_failed);
    } finally { if (valid(id)) { busyRef.current = false; setBusy(false); } }
  };
  useEffect(() => {
    setDocument(null); setDraft(null); setLoadedTarget('');
    void read();
    return () => { sequence.current++; };
  }, [target, bridge]);
  const review = async () => {
    if (busyRef.current || currentTarget.current !== target || loadedTarget !== target || !document || !draft) return;
    const id = ++sequence.current; busyRef.current = true; setBusy(true); setPreview(null); setError(null);
    try {
      const result = await bridge.preview({ context, assetId, expectedRevision: document.revision, payload: draft });
      if (valid(id)) { if (result.ok === true) setPreview(result.value); else setError(messages[result.code]); }
    } catch {
      // telemetry-exempt: show only a fixed transport failure.
      if (valid(id)) setError(messages.save_failed);
    } finally { if (valid(id)) { busyRef.current = false; setBusy(false); } }
  };
  const save = async () => {
    if (busyRef.current || currentTarget.current !== target || loadedTarget !== target || !document || !preview || preview.blocked) return;
    const id = ++sequence.current; busyRef.current = true; setBusy(true); setError(null);
    try {
      const result = await bridge.save({ context, assetId, expectedRevision: document.revision, token: preview.token });
      if (!valid(id)) return;
      setPreview(null);
      if (result.ok === true) { setDocument(result.value); setDraft(result.value.payload); }
      else setError(messages[result.code]);
    } catch {
      // telemetry-exempt: retain drafts, never log bundle contents or raw transport errors.
      if (valid(id)) { setPreview(null); setError(messages.save_failed); }
    } finally { if (valid(id)) { busyRef.current = false; setBusy(false); } }
  };
  return <section aria-label="Catalog skill bundle" className="space-y-3">
    <p className="text-xs text-ctp-subtext0">Catalog copy only. Saving does not assign, enable or run this skill.</p>
    <Button disabled={busy} onClick={() => { void read(); }}>Reload saved bundle{dirty ? ' and discard edits' : ''}</Button>
    {busy && <p role="status" className="text-xs text-ctp-subtext0">Loading catalog operation...</p>}
    {error && <p role="alert" className="text-xs text-ctp-error">{error}</p>}
    {document && draft && loadedTarget === target && <>
      <h3 className="text-[13px] font-semibold text-ctp-text">{document.name}</h3>
      <p className="text-xs text-ctp-subtext0">Catalog revision {document.revision}. Source: {document.source.kind}.
        {' '}Owner: {document.owner.kind}{document.owner.kind === 'agent' ? ` ${document.owner.agentId}` : document.owner.kind === 'project' ? ` ${document.owner.projectId}` : ''}.
        {document.source.kind === 'copy' ? ` Copied from ${document.source.originAssetId} at revision ${document.source.originRevision}.` : ''}
        {document.readOnly ? ' Built-in, read-only.' : ''}</p>
      <SkillBundleEditor key={target} value={draft} disabled={busy} readOnly={document.readOnly} onChange={(value) => {
        if (busyRef.current || currentTarget.current !== target) return;
        sequence.current++; setDraft(value); setPreview(null); setError(null);
      }} />
      {!document.readOnly && <div className="flex gap-2">
        <Button disabled={busy || !dirty} onClick={() => { void review(); }}>Review catalog edit</Button>
        <Button kind="primary" disabled={busy || !preview || preview.blocked} onClick={() => { void save(); }}>Save catalog revision</Button>
      </div>}
      {preview && <div className="space-y-1 text-xs text-ctp-subtext0">
        <p>Consumers: {preview.impact.agents.length} agents, {preview.impact.templates.length} templates, {preview.impact.subagents.length} subagents. Copies: {preview.impact.copies.length}.</p>
        {preview.blocked ? <p role="alert">{messages.shared_edit_blocked} No revision was saved.</p> : <p>This review covers the complete bundle, including every unchanged member.</p>}
      </div>}
    </>}
  </section>;
}
