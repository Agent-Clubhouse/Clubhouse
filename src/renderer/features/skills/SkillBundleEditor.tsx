import { useState } from 'react';
import type { SkillAssetPayload, SkillFile } from '../../../shared/asset-catalog-types';
import { Button } from '../../components/Button';
import { SettingsMonacoEditor } from '../../components/SettingsMonacoEditor';
import { skillPathError } from '../../../shared/skill-paths';

interface Props {
  value: SkillAssetPayload;
  onChange: (value: SkillAssetPayload) => void;
  readOnly?: boolean;
  disabled?: boolean;
}
interface Directory { files: SkillFile[]; directories: Map<string, Directory> }
function fileTree(files: SkillFile[]): Directory {
  const root: Directory = { files: [], directories: new Map() };
  for (const file of files) {
    let node = root;
    const parts = file.path.split('/');
    for (const part of parts.slice(0, -1)) {
      if (!node.directories.has(part)) node.directories.set(part, { files: [], directories: new Map() });
      node = node.directories.get(part)!;
    }
    node.files.push(file);
  }
  return root;
}
const pathError = (path: string, files: SkillFile[], replacing?: string) => skillPathError(path, files.map((file) => file.path), replacing);
function language(path: string) {
  const extension = path.split('.').pop();
  return ({ md: 'markdown', json: 'json', js: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', yaml: 'yaml', yml: 'yaml' } as Record<string, string>)[extension] ?? 'plaintext';
}

/** Controlled catalog payload editor. Never reads a filesystem, renders assets or executes scripts. */
export function SkillBundleEditor({ value, onChange, readOnly = false, disabled = false }: Props) {
  const [selectedPath, setSelectedPath] = useState('SKILL.md');
  const [newPath, setNewPath] = useState('');
  const [renamePath, setRenamePath] = useState('');
  const [newBinary, setNewBinary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = value.files.find((file) => file.path === selectedPath) ?? value.files[0];
  const locked = readOnly || disabled;
  const edit = (update: Partial<SkillFile>) => {
    if (locked || !selected) return;
    // Only this member changes. Binary content, encoding and executable metadata
    // of every other member remain byte-for-byte values from the saved payload.
    onChange({ ...value, files: value.files.map((file) => file.path === selected.path ? { ...file, ...update } : file) });
  };
  const choose = (path: string) => { setSelectedPath(path); setRenamePath(path); setError(null); };
  const renderTree = (node: Directory) => <ul className="space-y-1 pl-3">
    {[...node.directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => <li key={name}>
      <details open><summary className="cursor-pointer text-xs text-ctp-subtext0">{name}/</summary>{renderTree(child)}</details>
    </li>)}
    {node.files.map((file) => <li key={file.path}><button type="button" aria-pressed={selected?.path === file.path}
      title={file.path} className="text-xs text-ctp-text text-left break-all p-1 rounded hover:bg-surface-0 focus-visible:outline focus-visible:outline-1"
      onClick={() => choose(file.path)}>{file.path.split('/').pop()}{file.executable ? ' (executable)' : ''}</button></li>)}
  </ul>;
  return <div className="space-y-3">
    <p className="text-xs text-ctp-subtext0">Paths are relative to this catalog bundle. Scripts and assets are stored here without running or rendering them.</p>
    <div className="flex gap-4">
      <nav aria-label="Bundle files" className="w-52 shrink-0 overflow-auto max-h-96 border border-surface-1 rounded-md p-2">{renderTree(fileTree(value.files))}</nav>
      <div className="min-w-0 flex-1 space-y-2">
        {selected && <>
          <p className="text-xs font-mono text-ctp-text break-all">{selected.path}</p>
          <label className="flex gap-2 text-xs text-ctp-subtext0"><input type="checkbox" checked={!!selected.executable} disabled={locked}
            onChange={(event) => edit({ executable: event.target.checked })} />Executable metadata</label>
          {selected.encoding === 'base64' ? <label className="block text-xs text-ctp-subtext0">Binary bytes (base64)
            <textarea aria-label="Binary bytes (base64)" value={selected.content} readOnly={locked} spellCheck={false}
              className="w-full h-48 mt-1 rounded-md border border-surface-1 bg-ctp-base text-ctp-text font-mono p-2"
              onChange={(event) => edit({ content: event.target.value })} />
          </label> : <SettingsMonacoEditor value={selected.content} language={language(selected.path)} readOnly={locked}
            editorKey={selected.path} onChange={(content) => edit({ content })} />}
          {!readOnly && selected.path !== 'SKILL.md' && <div className="flex gap-2 items-end flex-wrap">
            <label className="text-xs text-ctp-subtext0">New relative path<input aria-label="New relative path" value={renamePath}
              disabled={disabled} onChange={(event) => setRenamePath(event.target.value)} className="block rounded-md border border-surface-1 bg-ctp-base text-ctp-text px-2 py-1" /></label>
            <Button disabled={disabled} onClick={() => {
              const target = renamePath;
              const issue = pathError(target, value.files, selected.path);
              if (issue) { setError(issue); return; }
              edit({ path: target }); choose(target);
            }}>Rename file</Button>
            <Button kind="danger" disabled={disabled} onClick={() => {
              onChange({ ...value, files: value.files.filter((file) => file.path !== selected.path) }); choose('SKILL.md');
            }}>Remove file</Button>
          </div>}
        </>}
      </div>
    </div>
    {!readOnly && <div className="flex items-end flex-wrap gap-2">
      <label className="text-xs text-ctp-subtext0">Relative path<input aria-label="Relative path" value={newPath} disabled={disabled}
        onChange={(event) => setNewPath(event.target.value)} className="block rounded-md border border-surface-1 bg-ctp-base text-ctp-text px-2 py-1" /></label>
      <label className="text-xs text-ctp-subtext0 flex gap-2 items-center"><input type="checkbox" checked={newBinary} disabled={disabled}
        onChange={(event) => setNewBinary(event.target.checked)} />Binary file</label>
      <Button disabled={disabled || value.files.length >= 500} onClick={() => {
        const issue = pathError(newPath, value.files);
        if (issue) { setError(issue); return; }
        onChange({ ...value, files: [...value.files, { path: newPath, content: '', encoding: newBinary ? 'base64' : 'utf8' }] });
        choose(newPath); setNewPath('');
      }}>Add file</Button>
    </div>}
    {error && <p role="alert" className="text-xs text-ctp-error">{error}</p>}
  </div>;
}
