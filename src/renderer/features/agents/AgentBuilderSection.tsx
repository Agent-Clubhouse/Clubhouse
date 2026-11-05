import { useEffect, useRef, useState } from 'react';
import type { BuilderBlock, BuilderCommand, BuilderView } from '../../../shared/agent-builder-types';
import type { TemplateOperationalDefaults } from '../../../shared/asset-catalog-types';
import { Button } from '../../components/Button';
import { inputClass, selectClass, textareaClass, SectionHeading } from './agentSettingsUi';
import { useReportDirty } from './agentSettingsPages';

const SAVED_ONLY = "Changes are saved here and aren't used by this agent yet.";

const OPERATIONAL_LABELS: Record<keyof TemplateOperationalDefaults, string> = {
  agentAccess: 'Agent access', orchestrate: 'Start helpers', access: 'Helper access',
  control: 'Helper approvals', maxHelpers: 'Helper limit', crossProjectHelpers: 'Cross-project helpers',
  connectToDispatcher: 'Dispatcher connection', autoHelpers: 'Automatic helper provider',
};
function operationalValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  const labels: Record<string, string> = {
    standard: 'Ask for permissions', auto: 'Automatic permissions', bypass: 'Skip permission prompts',
    same: 'Same as agent', 'hands-off': 'Without approvals', 'ask-before-start': 'Ask before starting', 'ask-everything': 'Ask before each action',
  };
  return typeof value === 'string' ? labels[value] ?? value : String(value);
}

export function AgentBuilderSection({ projectPath, agentId, onDirtyChange }: {
  projectPath: string; agentId: string; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [view, setView] = useState<BuilderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [template, setTemplate] = useState('');
  const [acknowledgeIncreases, setAcknowledgeIncreases] = useState(false);
  const [replacement, setReplacement] = useState<BuilderView | null>(null);
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  const dragKey = useRef<string | null>(null);
  const operation = useRef(false);
  const dirty = Object.keys(drafts).length > 0 || !!name || !!content || !!replacement;
  useReportDirty(onDirtyChange, dirty);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError('');
    window.clubhouse.agentSettings.builderRead(projectPath, agentId).then((result) => {
      if (cancelled) return;
      if (result.ok) { setView(result.view); setTemplate(result.view.templateId ?? ''); }
      else setError('Could not load the Builder. Try Reload.');
    }).catch(() => {
      // telemetry-exempt: instruction content stays out of telemetry; error shown here.
      if (!cancelled) setError('Could not load the Builder. Try Reload.');
    });
    return () => { cancelled = true; };
  }, [projectPath, agentId]);

  const displayed = replacement ?? view;
  const blocks = displayed?.blocks ?? [];
  const previewContents = blocks.map((block) => drafts[block.key] ?? block.content);
  const previewKey = JSON.stringify(previewContents);
  useEffect(() => {
    let cancelled = false;
    setPreviewError('');
    window.clubhouse.agentSettings.builderPreview(JSON.parse(previewKey) as string[]).then((result) => {
      if (cancelled) return;
      if (result.ok) setPreview(result.text);
      else { setPreview(''); setPreviewError('The preview is too large. Shorten a block.'); }
    }).catch(() => {
      // telemetry-exempt: instruction content stays out of telemetry; error shown here.
      if (!cancelled) { setPreview(''); setPreviewError('Could not compose the preview.'); }
    });
    return () => { cancelled = true; };
  }, [previewKey]);

  async function reload() {
    const result = await window.clubhouse.agentSettings.builderRead(projectPath, agentId);
    if (result.ok === false) throw new Error('builder_read_failed');
    setView(result.view);
    setTemplate(result.view.templateId ?? '');
    setDrafts({});
    setReplacement(null);
    setName('');
    setContent('');
  }
  async function run(action: BuilderCommand, optimistic?: BuilderView, message = 'Saved in Builder.') {
    if (!view || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    if (optimistic) setView(optimistic);
    try {
      const result = await window.clubhouse.agentSettings.builderCommand(projectPath, agentId, view.revision, action);
      if (result.ok === false) {
        setView(view);
        setDrafts({});
        setReplacement(null);
        setName('');
        setContent('');
        setError(result.code === 'stale' ? 'The saved Builder changed elsewhere. Your changes were not saved. Reloaded the latest version.' : 'Could not save. Your changes were reverted.');
        await reload();
        return;
      }
      if (action.type === 'template' && !action.confirm) {
        setAcknowledgeIncreases(false);
        setReplacement(result.view);
      } else {
        setView(result.view);
        setTemplate(result.view.templateId ?? '');
        setDrafts({});
        setReplacement(null);
        if (action.type === 'append') { setName(''); setContent(''); }
        setAnnouncement(message);
      }
    } catch {
      // telemetry-exempt: revert visibly; never send block text or raw IPC errors to telemetry.
      setView(view);
      setDrafts({});
      setReplacement(null);
      setName('');
      setContent('');
      setTemplate(view.templateId ?? '');
      setError('Could not save or reload. Showing the last loaded version. Try Reload.');
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  function move(from: number, to: number) {
    if (!view || from === to || to < 0 || to >= view.blocks.length) return;
    const reordered = [...view.blocks];
    const [block] = reordered.splice(from, 1);
    reordered.splice(to, 0, block);
    void run({ type: 'order', keys: reordered.map((b) => b.key) }, { ...view, blocks: reordered }, `Moved ${block.name} to position ${to + 1}. Saved in Builder.`);
  }
  const locked = busy || !!replacement;
  const hasEdits = Object.keys(drafts).length > 0 || !!name || !!content;
  function discardReplacement() { setReplacement(null); setTemplate(view?.templateId ?? ''); }
  function row(block: BuilderBlock, index: number) {
    return (
      <li key={block.key} data-testid="builder-block" className="py-3 border-t border-surface-0"
        onDragOver={(event) => { if (!locked && !hasEdits) event.preventDefault(); }}
        onDrop={(event) => {
          event.preventDefault();
          if (!view || locked || hasEdits) return;
          const from = view.blocks.findIndex((b) => b.key === dragKey.current);
          dragKey.current = null;
          if (from >= 0) move(from, index);
        }}>
        <div className="flex items-start gap-2">
          <button type="button" draggable={!locked && !hasEdits} disabled={locked || hasEdits}
            aria-label={`Reorder ${block.name}`} aria-describedby="builder-reorder-help"
            className="h-7 px-1 text-ctp-subtext0 cursor-grab focus-visible:outline focus-visible:outline-1 disabled:opacity-40"
            onDragStart={(event) => { dragKey.current = block.key; event.dataTransfer.setData('text/plain', block.key); event.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => { dragKey.current = null; }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); move(index, index + (event.key === 'ArrowUp' ? -1 : 1)); }
            }}>↕</button>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-ctp-text">{index + 1}. {block.name}</div>
            <div className="text-xs text-ctp-overlay1">{block.source}</div>
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            <Button kind="quiet" aria-label={`Move ${block.name} up`} disabled={locked || hasEdits || index === 0} onClick={() => move(index, index - 1)}>Move up</Button>
            <Button kind="quiet" aria-label={`Move ${block.name} down`} disabled={locked || hasEdits || index === blocks.length - 1} onClick={() => move(index, index + 1)}>Move down</Button>
            {!block.editable && <Button kind="ghost" disabled={locked || hasEdits} onClick={() => void run({ type: 'fork', key: block.key })}>Fork block</Button>}
            {block.entry.source.kind === 'fork' && <Button kind="quiet" disabled={locked || hasEdits} onClick={() => void run({ type: 'return', key: block.key })}>Return to template</Button>}
            {block.entry.source.kind === 'local' && <Button kind="quiet" disabled={locked || hasEdits} onClick={() => void run({ type: 'remove', key: block.key })}>Remove block</Button>}
          </div>
        </div>
        {block.editable ? <div className="mt-2">
          <label htmlFor={`builder-text-${block.key}`} className="sr-only">{block.name} text</label>
          <textarea id={`builder-text-${block.key}`} className={`${textareaClass} min-h-28`} value={drafts[block.key] ?? block.content} disabled={locked || (Object.keys(drafts).length > 0 && drafts[block.key] === undefined)}
            onChange={(event) => {
              const value = event.target.value;
              setDrafts((current) => { const next = { ...current }; if (value === block.content) delete next[block.key]; else next[block.key] = value; return next; });
            }} />
          {drafts[block.key] !== undefined && <div className="flex gap-2 mt-1">
            <Button kind="primary" disabled={locked} onClick={() => void run({ type: 'edit', key: block.key, content: drafts[block.key] })}>Save block</Button>
            <Button kind="quiet" disabled={locked} onClick={() => setDrafts((current) => { const next = { ...current }; delete next[block.key]; return next; })}>Discard edit</Button>
          </div>}
        </div> : <details className="mt-2 text-xs text-ctp-subtext0"><summary className="cursor-pointer">Source text</summary><pre className="whitespace-pre-wrap mt-2">{block.content}</pre></details>}
      </li>
    );
  }
  return <section data-testid="agent-builder" aria-label="Builder" className="text-[13px]">
    <div className="sticky top-0 z-10 bg-ctp-base py-3 border-b border-surface-0">
      <p className="font-medium text-ctp-text">Saved in Builder only</p>
      <p className="text-ctp-subtext1 mt-1">{SAVED_ONLY}</p>
    </div>
    <div className="flex items-center justify-between my-3">
      <p className="text-xs text-ctp-overlay1">Instruction blocks. Wildcards stay unexpanded.</p>
      <Button kind="quiet" disabled={busy || dirty} onClick={() => { setError(''); void reload().catch(() => {
        // telemetry-exempt: visible error, no instruction content in telemetry.
        setError('Could not reload the Builder.');
      }); }}>Reload</Button>
    </div>
    {error && <p role="alert" className="text-ctp-error my-3">{error}</p>}
    <p role="status" aria-live="polite" className="text-xs text-ctp-subtext0">{busy ? 'Saving in Builder…' : announcement}</p>
    {!view ? <p className="text-ctp-subtext0">{error ? 'Builder unavailable.' : 'Loading Builder…'}</p> : <>
      <label htmlFor="builder-template" className="block mb-1">Choose a template</label>
      <select id="builder-template" className={`${selectClass} my-1`} value={template} disabled={busy || hasEdits}
        onChange={(event) => { setTemplate(event.target.value); void run({ type: 'template', templateId: event.target.value, confirm: false }); }}>
        <option value="" disabled>Choose a template</option>
        {view.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      {replacement && <div className="my-3 space-y-2">
        <p>This replaces the saved block list. Forks and local blocks will be left out. Review the preview below before saving.</p>
        {!!replacement.operationalIncreases?.length && <div>
          <p>This template raises these saved operational defaults. They aren't used by this agent yet.</p>
          <ul aria-label="Operational increases" className="list-disc pl-5 my-2">
            {replacement.operationalIncreases.map((item) => <li key={item.key}>{OPERATIONAL_LABELS[item.key]}: {operationalValue(item.value)}</li>)}
          </ul>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={acknowledgeIncreases} disabled={busy} onChange={(event) => setAcknowledgeIncreases(event.target.checked)} />
            I agree to save these increases in Builder
          </label>
        </div>}
        <div className="flex gap-2"><Button kind="primary" disabled={busy || (!!replacement.operationalIncreases?.length && !acknowledgeIncreases)} onClick={() => void run({ type: 'template', templateId: template, confirm: true, binding: replacement.templateBinding, ...(replacement.operationalIncreases?.length ? { acknowledgeOperationalIncreases: acknowledgeIncreases } : {}) })}>Save template</Button>
          <Button kind="quiet" disabled={busy} onClick={discardReplacement}>Cancel</Button></div>
      </div>}
      {view.templateId && !replacement && <>
        <div className="flex items-center justify-between mt-4"><span>{view.customOrder ? 'Custom order' : 'Template order'}</span>
          {view.customOrder && <Button kind="quiet" disabled={locked || hasEdits} onClick={() => void run({ type: 'baseOrder' })}>Use base order</Button>}</div>
        <p id="builder-reorder-help" className="text-xs text-ctp-overlay1 mt-1">Drag a block, use Move up or Move down, or focus its reorder button and press the arrow keys. Local blocks stay after the base when you use base order.</p>
      </>}
      <ol aria-label="Ordered instruction blocks" className="mt-2">{blocks.map(row)}</ol>
      {view.templateId && !replacement && <form className="border-t border-surface-0 pt-3" onSubmit={(event) => { event.preventDefault(); void run({ type: 'append', name: name.trim(), content }); }}>
        <SectionHeading title="Append a local block" />
        <label htmlFor="builder-name" className="block text-xs text-ctp-subtext0 mb-1">Block name</label>
        <input id="builder-name" className={`${inputClass} w-full mb-2`} maxLength={120} value={name} disabled={locked || Object.keys(drafts).length > 0} onChange={(event) => setName(event.target.value)} />
        <label htmlFor="builder-content" className="block text-xs text-ctp-subtext0 mb-1">Block text</label>
        <textarea id="builder-content" className={`${textareaClass} min-h-28`} value={content} disabled={locked || Object.keys(drafts).length > 0} onChange={(event) => setContent(event.target.value)} />
        <Button type="submit" kind="ghost" disabled={locked || !name.trim() || !content || Object.keys(drafts).length > 0}>Add block</Button>
        {(name || content) && <Button kind="quiet" disabled={locked} onClick={() => { setName(''); setContent(''); }}>Discard new block</Button>}
      </form>}
      <SectionHeading title="Effective preview" />
      <p className="text-xs text-ctp-overlay1 mb-2">Exact composed text for these blocks. Wildcards are unexpanded. {Object.keys(drafts).length > 0 ? 'Includes unsaved block edits.' : 'Saved in Builder only.'}</p>
      {previewError && <p role="alert" className="text-ctp-error">{previewError}</p>}
      <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 items-start">
        <ol aria-label="Preview block boundaries" className="text-xs text-ctp-overlay1 space-y-2">
          {blocks.map((b, i) => {
            const startLine = 1 + previewContents.slice(0, i).reduce((n, text) => n + text.split('\n').length + 1, 0);
            return <li key={b.key}>{i + 1}. {b.name}<br />Lines {startLine} to {startLine + previewContents[i].split('\n').length - 1}<br />{b.source}</li>;
          })}
        </ol>
        <pre data-testid="builder-effective-preview" className="whitespace-pre-wrap break-words min-w-0 text-xs font-mono text-ctp-text border border-surface-0 rounded-md p-3">{preview}</pre>
      </div>
    </>}
  </section>;
}
