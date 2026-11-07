import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { inputClass, selectClass, textareaClass } from '../agents/agentSettingsUi';
import type { ManagedPart, ManagedPartConsumer, ManagedPartContent, ManagedPartKind, ManagedPartSummary, ManagedSkillContent } from '../../../shared/managed-agents-types';
import { ImpactDialog, needsImpactDialog } from './ImpactDialog';
import { errorText, isStale, managed, partKindLabel, unwrap } from './managedApi';
import { WildcardBar } from './parts-ui';
import { noteRunningLeftAlone, restartAfterSave } from './restart';
import { StaleEditDialog } from './StaleEditDialog';

type SkillFile = ManagedSkillContent['files'][number];

const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|sh|zsh|bash|py|js|mjs|cjs|ts|tsx|jsx|rb|go|rs|java|kt|swift|c|h|cpp|css|html|xml|csv|ini|cfg|env\.example)$/i;

async function readFileAsSkillFile(file: File, relPath: string): Promise<SkillFile> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const looksText = TEXT_EXT.test(relPath) || !buf.subarray(0, 4096).includes(0);
  if (looksText) {
    const content = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { path: relPath, content, ...(/\.(sh|zsh|bash|py)$/i.test(relPath) && { executable: true }) };
  }
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return { path: relPath, content: btoa(binary), encoding: 'base64' };
}

/** Walk a dropped folder (webkitGetAsEntry) into relative file paths. */
async function filesFromEntry(entry: FileSystemEntry, prefix = ''): Promise<Array<{ file: File; path: string }>> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ file, path: prefix + entry.name }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    children.push(...batch);
  }
  const out: Array<{ file: File; path: string }> = [];
  for (const child of children) out.push(...await filesFromEntry(child, `${prefix}${entry.name}/`));
  return out;
}

/** Arguments, one per line. Blank lines are dropped. */
export function parseArgs(text: string): string[] {
  return text.split('\n').map((x) => x.replace(/\r$/, '')).filter((x) => x.length > 0);
}

/** Variable names, separated by commas, spaces or new lines. */
export function parseEnvVars(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

function blankContent(kind: ManagedPartKind): ManagedPartContent {
  if (kind === 'block') return { kind, content: '' };
  if (kind === 'skill') return { kind, skillName: '', files: [{ path: 'SKILL.md', content: '' }] };
  return { kind, serverKey: '', transport: 'stdio', command: '', args: [], envVars: [] };
}

/**
 * Create or edit a block, skill or MCP server (#2894, #2895). Created here,
 * it's saved to the library and `onCreated` adds it to the agent. Editing a
 * part others use asks first (#2897).
 */
export function PartDialog({ open, kind, editId, agentName, wildcardValues, onClose, onCreated }: {
  open: boolean;
  kind: ManagedPartKind;
  /** Edit this part instead of creating one. */
  editId?: string;
  agentName?: string;
  wildcardValues?: Partial<Record<string, string>>;
  onClose: () => void;
  onCreated?: (part: ManagedPartSummary) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState<ManagedPartContent>(() => blankContent(kind));
  const [revision, setRevision] = useState(0);
  const [usedBy, setUsedBy] = useState<ManagedPartConsumer[]>([]);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([]);
  // Saving found a newer version (#2897): theirs, and the restarts the person had ticked.
  const [stale, setStale] = useState<{ theirs: ManagedPart; restart: ManagedPartConsumer[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState(false);
  // MCP arguments and variable names as typed: parsed on save, so a trailing
  // new line or comma isn't swallowed while the person is still typing.
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setImpact(false);
    setStale(null);
    if (!editId) {
      setName(''); setDescription(''); setContent(blankContent(kind)); setRevision(0); setUsedBy([]); setTemplates([]); setArgsText(''); setEnvText('');
      return;
    }
    let cancelled = false;
    void unwrap(managed().getPart(editId)).then((p) => {
      if (cancelled) return;
      setName(p.name); setDescription(p.description); setContent(p.content); setRevision(p.revision); setUsedBy(p.usedBy); setTemplates(p.templates);
      setArgsText(p.content.kind === 'mcp' ? (p.content.args ?? []).join('\n') : '');
      setEnvText(p.content.kind === 'mcp' ? (p.content.envVars ?? []).join(', ') : '');
    }).catch((err) => { /* telemetry-exempt: shown to the person */ if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [open, editId, kind]);

  const addFiles = async (items: Array<{ file: File; path: string }>) => {
    if (content.kind !== 'skill') return;
    // A dropped skill folder: strip the folder name and take the skill name from it.
    const roots = new Set(items.map((i) => i.path.split('/')[0]));
    const singleRoot = items.length > 0 && items.every((i) => i.path.includes('/')) && roots.size === 1 ? [...roots][0] : null;
    const files: SkillFile[] = [...content.files.filter((f) => !(f.path === 'SKILL.md' && !f.content))];
    for (const item of items) {
      const rel = singleRoot ? item.path.slice(singleRoot.length + 1) : item.path;
      const next = await readFileAsSkillFile(item.file, rel);
      const at = files.findIndex((f) => f.path === rel);
      if (at >= 0) files[at] = next; else files.push(next);
    }
    setContent({ ...content, files, skillName: content.skillName || (singleRoot ?? content.skillName) });
    if (!name && singleRoot) setName(singleRoot);
  };

  const onDrop = async (e: React.DragEvent) => {
    if (content.kind !== 'skill') return;
    e.preventDefault();
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    const items: Array<{ file: File; path: string }> = [];
    for (const entry of entries) items.push(...await filesFromEntry(entry));
    await addFiles(items);
  };

  /** The content as it will be saved: MCP arguments and names parsed from what was typed. */
  const toSave = (): ManagedPartContent => (content.kind === 'mcp'
    ? { ...content, ...(content.transport === 'stdio' && { args: parseArgs(argsText) }), envVars: parseEnvVars(envText) }
    : content);

  /** Save. `expected` is their revision when the person chose Keep mine, so a third change is still caught. */
  const commit = async (restart: ManagedPartConsumer[] = [], expected = revision) => {
    setBusy(true);
    setError(null);
    const saved = toSave();
    let reached: ManagedPartConsumer[] = [];
    try {
      if (editId) {
        reached = (await unwrap(managed().updatePart({ id: editId, expectedRevision: expected, name, description, content: saved }))).usedBy;
      } else {
        const created = await unwrap(managed().createPart({ name, description, content: saved }));
        onCreated?.(created);
      }
    } catch (err) {
      // telemetry-exempt: a newer version is shown beside this one; anything else in the dialog.
      if (editId && isStale(err)) {
        try {
          setStale({ theirs: await unwrap(managed().getPart(editId)), restart });
        } catch (readErr) { /* telemetry-exempt: shown in the dialog */ setError(errorText(readErr)); }
      } else {
        setError(errorText(err));
      }
      setBusy(false);
      setImpact(false);
      return;
    }
    setBusy(false);
    setImpact(false);
    setStale(null);
    onClose();
    // Saved: restarts run on their own and report their own failures.
    restartAfterSave(restart.map(({ projectPath, agentId, agentName }) => ({ projectPath, agentId, agentName })));
    noteRunningLeftAlone(reached, restart);
  };
  const save = () => {
    if (editId && needsImpactDialog({ usedBy, templates })) setImpact(true);
    else void commit();
  };
  /** Stale, and the person wants their version kept apart: a library copy with their edit, the shared part untouched. */
  const saveAsCopy = async () => {
    if (!editId) return;
    setBusy(true);
    setError(null);
    try {
      const copy = await unwrap(managed().forkPart(editId));
      await unwrap(managed().updatePart({ id: copy.id, expectedRevision: copy.revision, description, content: toSave() }));
    } catch (err) {
      // telemetry-exempt: shown in the dialog.
      setError(errorText(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setStale(null);
    onClose();
  };

  const title = `${editId ? 'Edit' : 'New'} ${partKindLabel(kind).toLowerCase()}`.replace(/^./, (c) => c.toUpperCase());
  const valid = name.trim() && (content.kind !== 'skill' || content.skillName.trim()) && (content.kind !== 'mcp' || (content.serverKey.trim() && (content.transport === 'stdio' ? content.command?.trim() : content.url?.trim())));

  return (
    <>
      <Modal
        open={open && !impact && !stale}
        onClose={onClose}
        onDismiss={() => {}}
        title={title}
        width="w-[640px]"
        testId="managed-part-dialog"
        footer={<>
          <span className="mr-auto self-center text-xs text-ctp-overlay1">
            {editId
              ? (usedBy.length > 1 ? `Used by ${usedBy.length} agents. They get the change at their next start.` : 'Applies at the next start.')
              : `Saved to the library${agentName ? ` and added to ${agentName}` : ''}.`}
          </span>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button kind="primary" onClick={save} disabled={busy || !valid} data-testid="managed-part-save">{editId ? 'Save' : `Create ${partKindLabel(kind).toLowerCase()}`}</Button>
        </>}
      >
        <div className="flex flex-col gap-3 text-[13px]" onDragOver={(e) => { if (content.kind === 'skill') e.preventDefault(); }} onDrop={(e) => void onDrop(e)}>
          {content.kind === 'skill' && !editId && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-surface-2 text-xs text-ctp-subtext0" title="Drop a skill folder here, or use Add files. Files are copied in, never linked.">
              Drop a skill folder here to fill this in. Its files are copied into the library.
            </div>
          )}
          <label className="flex items-center gap-4">
            <span className="w-28 text-ctp-subtext1">Name</span>
            <input className={`${inputClass} flex-1`} value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="managed-part-name" />
          </label>
          <label className="flex items-start gap-4">
            <span className="w-28 pt-1.5 text-ctp-subtext1">Description</span>
            <span className="flex-1 flex flex-col gap-1">
              <input className={`${inputClass} w-full`} value={description} onChange={(e) => setDescription(e.target.value)} data-testid="managed-part-description" />
              <span className="text-xs text-ctp-overlay1">{kind === 'skill' ? 'Agents read this to decide when to use the skill.' : 'Shown in the library so you can tell parts apart.'}</span>
            </span>
          </label>

          {content.kind === 'block' && (
            <div className="flex items-start gap-4">
              <span className="w-28 pt-1.5 text-ctp-subtext1">Text</span>
              <span className="flex-1 flex flex-col gap-2">
                <textarea aria-label="Block text" className={`${textareaClass} min-h-40`} value={content.content} onChange={(e) => setContent({ kind: 'block', content: e.target.value })} />
                <WildcardBar values={wildcardValues} />
              </span>
            </div>
          )}

          {content.kind === 'skill' && (
            <>
              <label className="flex items-center gap-4">
                <span className="w-28 text-ctp-subtext1">Folder name</span>
                <input className={`${inputClass} flex-1 font-mono`} value={content.skillName} onChange={(e) => setContent({ ...content, skillName: e.target.value })} placeholder="release-notes" data-testid="managed-part-skill-name" />
              </label>
              <div className="flex items-start gap-4">
                <span className="w-28 pt-1.5 text-ctp-subtext1">Instructions</span>
                <textarea
                  aria-label="SKILL.md"
                  data-testid="managed-part-skill-md"
                  className={`${textareaClass} flex-1 min-h-32`}
                  value={content.files.find((f) => f.path === 'SKILL.md')?.content ?? ''}
                  onChange={(e) => {
                    const files = content.files.some((f) => f.path === 'SKILL.md')
                      ? content.files.map((f) => (f.path === 'SKILL.md' ? { ...f, content: e.target.value } : f))
                      : [{ path: 'SKILL.md', content: e.target.value }, ...content.files];
                    setContent({ ...content, files });
                  }}
                />
              </div>
              <div className="flex items-start gap-4">
                <span className="w-28 pt-1.5 text-ctp-subtext1">Files</span>
                <div className="flex-1 flex flex-col gap-1.5">
                  <ul className="rounded-md border border-surface-1" data-testid="managed-skill-files">
                    {content.files.filter((f) => f.path !== 'SKILL.md').map((f) => (
                      <li key={f.path} className="flex items-center gap-2 px-2 py-1.5 border-b border-surface-0 last:border-b-0">
                        <span className="font-mono text-xs text-ctp-text truncate">{f.path}</span>
                        {f.encoding === 'base64' && <span className="text-xs text-ctp-overlay1">binary</span>}
                        <label className="ml-auto flex items-center gap-1 text-xs text-ctp-overlay1">
                          <input type="checkbox" aria-label={`Executable: ${f.path}`} checked={!!f.executable} onChange={(e) => setContent({ ...content, files: content.files.map((x) => (x.path === f.path ? { ...x, executable: e.target.checked } : x)) })} />
                          executable
                        </label>
                        <Button kind="quiet" aria-label={`Remove ${f.path}`} onClick={() => setContent({ ...content, files: content.files.filter((x) => x.path !== f.path) })}>Remove</Button>
                      </li>
                    ))}
                    {content.files.filter((f) => f.path !== 'SKILL.md').length === 0 && <li className="px-2 py-1.5 text-xs text-ctp-overlay1">Only SKILL.md.</li>}
                  </ul>
                  <div className="flex items-center gap-2">
                    <Button kind="quiet" onClick={() => fileInput.current?.click()}>Add files…</Button>
                    <Button kind="quiet" onClick={() => folderInput.current?.click()}>Add a folder…</Button>
                    <span className="text-xs text-ctp-overlay1">Files are copied in, never linked to where they came from. Scripts never run in Clubhouse.</span>
                  </div>
                  <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const fl = [...(e.target.files ?? [])]; void addFiles(fl.map((file) => ({ file, path: file.name }))); e.target.value = ''; }} />
                  <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={(e) => { const fl = [...(e.target.files ?? [])]; void addFiles(fl.map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))); e.target.value = ''; }} />
                </div>
              </div>
            </>
          )}

          {content.kind === 'mcp' && (
            <>
              <label className="flex items-center gap-4">
                <span className="w-28 text-ctp-subtext1">Server key</span>
                <input className={`${inputClass} flex-1 font-mono`} value={content.serverKey} onChange={(e) => setContent({ ...content, serverKey: e.target.value })} placeholder="workiq" data-testid="managed-part-server-key" />
              </label>
              <label className="flex items-center gap-4">
                <span className="w-28 text-ctp-subtext1">Transport</span>
                <select className={selectClass} data-testid="managed-part-transport" value={content.transport} onChange={(e) => setContent({ ...content, transport: e.target.value as 'stdio' | 'http' | 'sse' })}>
                  <option value="stdio">Command (stdio)</option>
                  <option value="http">URL (HTTP)</option>
                  <option value="sse">URL (SSE)</option>
                </select>
              </label>
              {content.transport === 'stdio' ? (
                <>
                  <label className="flex items-center gap-4">
                    <span className="w-28 text-ctp-subtext1">Command</span>
                    <input className={`${inputClass} flex-1 font-mono`} value={content.command ?? ''} onChange={(e) => setContent({ ...content, command: e.target.value })} placeholder="npx" data-testid="managed-part-command" />
                  </label>
                  <label className="flex items-start gap-4">
                    <span className="w-28 pt-1.5 text-ctp-subtext1">Arguments</span>
                    <span className="flex-1 flex flex-col gap-1">
                      <textarea aria-label="Arguments" data-testid="managed-part-args" className={`${textareaClass} min-h-16`} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
                      <span className="text-xs text-ctp-overlay1">One per line.</span>
                    </span>
                  </label>
                </>
              ) : (
                <label className="flex items-center gap-4">
                  <span className="w-28 text-ctp-subtext1">URL</span>
                  <input className={`${inputClass} flex-1 font-mono`} value={content.url ?? ''} onChange={(e) => setContent({ ...content, url: e.target.value })} />
                </label>
              )}
              <label className="flex items-start gap-4">
                <span className="w-28 pt-1.5 text-ctp-subtext1">Environment</span>
                <span className="flex-1 flex flex-col gap-1">
                  <input aria-label="Environment" data-testid="managed-part-env" className={`${inputClass} w-full font-mono`} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="WORKIQ_TENANT" />
                  <span className="text-xs text-ctp-overlay1">Variable names only. Values come from your signed-in environment when the agent starts. Clubhouse stores no secrets.</span>
                </span>
              </label>
            </>
          )}
          {error && <p role="alert" className="text-xs text-ctp-error">{error}</p>}
        </div>
      </Modal>
      {impact && (
        <ImpactDialog open partName={name} consumers={usedBy} templates={templates} busy={busy} error={error} onCancel={() => setImpact(false)} onSave={(restart) => void commit(restart)} />
      )}
      {stale && (
        <StaleEditDialog
          theirs={stale.theirs}
          mine={{ name, description, content: toSave() }}
          busy={busy}
          error={error}
          onKeepMine={() => { setRevision(stale.theirs.revision); void commit(stale.restart, stale.theirs.revision); }}
          onTakeTheirs={() => { setStale(null); onClose(); }}
          onFork={() => void saveAsCopy()}
          forkLabel="Save mine as a copy"
        />
      )}
    </>
  );
}
