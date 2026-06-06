import { useEffect, useState } from 'react';

/** A selectable, authorable library item (mission or persona). */
export interface LibraryOption {
  id: string;
  /** Display label (falls back to id). */
  label?: string;
  /** Origin marker shown as a chip; e.g. 'builtin' | 'user' | 'project'. */
  source?: string;
}

/** A writable storage scope for authored items (e.g. project vs user-global). */
export interface ScopeOption {
  value: string;
  label: string;
}

interface Props {
  /** Wildcard token shown as the field label, e.g. "@@Mission". */
  token: string;
  /** Short helper text under the label. */
  help: string;
  /** Currently selected per-agent override id ('' = inherit project default). */
  value: string;
  /** Project default id (shown in the inherit option), or null. */
  projectDefault: string | null;
  /** Available items to choose from. */
  options: LibraryOption[];
  /** Noun used in prompts/buttons, e.g. "mission" | "persona". */
  noun: string;
  disabled?: boolean;
  /** Update the selected override id (form-local; persisted by the parent Save). */
  onChange: (id: string) => void;
  /** Load the editable content for an id. */
  loadContent: (id: string) => Promise<string>;
  /** Persist content for an id (create or overwrite), to the given scope when provided. */
  saveContent: (id: string, content: string, scope?: string) => Promise<void>;
  /** Delete a library item by id, from the given scope when provided. */
  deleteItem: (id: string, scope?: string) => Promise<void>;
  /** Called after the library changes so the parent can refresh option lists. */
  onLibraryChanged: () => void;
  /** When set, the editor shows a storage-scope selector (e.g. project vs user-global). */
  scopeOptions?: ScopeOption[];
  /** Initial/selected scope value when the editor opens (defaults to the first scope option). */
  initialScope?: string;
}

const ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

type EditorMode = 'closed' | 'edit' | 'new';

/**
 * A wildcard field backed by an authorable file library (missions, personas).
 * Renders a dropdown of available items plus an inline editor that supports
 * editing an existing item ("Save"), forking it ("Save as new copy"), and
 * authoring a brand-new item.
 */
export function WildcardLibraryField({
  token,
  help,
  value,
  projectDefault,
  options,
  noun,
  disabled,
  onChange,
  loadContent,
  saveContent,
  deleteItem,
  onLibraryChanged,
  scopeOptions,
  initialScope,
}: Props) {
  const [mode, setMode] = useState<EditorMode>('closed');
  const [content, setContent] = useState('');
  const [copyId, setCopyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<string>(initialScope ?? scopeOptions?.[0]?.value ?? '');

  const resetScope = () => setScope(initialScope ?? scopeOptions?.[0]?.value ?? '');

  // Close the editor whenever the field is disabled (e.g. agent starts running).
  useEffect(() => {
    if (disabled) setMode('closed');
  }, [disabled]);

  const inheritLabel = projectDefault
    ? `Inherit project default (${projectDefault})`
    : 'None (inherit project default)';

  const openEdit = async () => {
    if (!value) return;
    setError('');
    resetScope();
    setLoading(true);
    setMode('edit');
    setCopyId('');
    try {
      setContent(await loadContent(value));
    } catch {
      setContent('');
    } finally {
      setLoading(false);
    }
  };

  const openNew = () => {
    setError('');
    resetScope();
    setContent('');
    setCopyId('');
    setMode('new');
  };

  const close = () => {
    setMode('closed');
    setError('');
  };

  const validateId = (id: string): boolean => {
    if (!ID_PATTERN.test(id)) {
      setError('Use only letters, numbers, dots, dashes, and underscores.');
      return false;
    }
    return true;
  };

  // Overwrite the currently-selected item.
  const handleSave = async () => {
    if (!value) return;
    setSaving(true);
    setError('');
    try {
      await saveContent(value, content, scopeOptions ? scope : undefined);
      onLibraryChanged();
      setMode('closed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  // Write to a new id and select it.
  const handleSaveAsCopy = async () => {
    const id = copyId.trim();
    if (!id) {
      setError(`Enter an id for the new ${noun}.`);
      return;
    }
    if (!validateId(id)) return;
    if (options.some((o) => o.id === id)) {
      setError(`A ${noun} named "${id}" already exists.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await saveContent(id, content, scopeOptions ? scope : undefined);
      onLibraryChanged();
      onChange(id);
      setMode('closed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!value) return;
    setSaving(true);
    setError('');
    try {
      await deleteItem(value, scopeOptions ? scope : undefined);
      onLibraryChanged();
      onChange('');
      setMode('closed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-mono text-ctp-text">{token}</span>
      </div>
      <p className="text-xs text-ctp-subtext0/60 mb-1">{help}</p>
      <div className="flex gap-2">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="flex-1 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="">{inheritLabel}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {(o.label || o.id) + (o.source && o.source !== 'builtin' ? ` · ${o.source}` : '')}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={openEdit}
          disabled={disabled || !value || mode !== 'closed'}
          className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={value ? `Edit this ${noun}` : `Select a ${noun} to edit`}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={openNew}
          disabled={disabled || mode !== 'closed'}
          className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          New…
        </button>
      </div>

      {mode !== 'closed' && (
        <div className="mt-2 border border-surface-1 rounded-lg p-2 space-y-2 bg-ctp-mantle">
          {mode === 'new' && (
            <div>
              <label className="block text-xs text-ctp-subtext0 mb-1">New {noun} id</label>
              <input
                type="text"
                value={copyId}
                onChange={(e) => setCopyId(e.target.value)}
                placeholder={`my-${noun}`}
                className="w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text placeholder:text-ctp-overlay0 focus-ring"
              />
            </div>
          )}
          <textarea
            value={loading ? 'Loading…' : content}
            onChange={(e) => setContent(e.target.value)}
            disabled={loading || saving}
            spellCheck={false}
            placeholder={`Markdown content for this ${noun}…`}
            className="w-full h-40 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-2 resize-y border border-surface-1 focus-ring"
          />
          {mode === 'edit' && (
            <div>
              <label className="block text-xs text-ctp-subtext0 mb-1">New copy id (for “Save as new copy”)</label>
              <input
                type="text"
                value={copyId}
                onChange={(e) => setCopyId(e.target.value)}
                placeholder={`${value}-copy`}
                className="w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text placeholder:text-ctp-overlay0 focus-ring"
              />
            </div>
          )}
          {scopeOptions && scopeOptions.length > 0 && (
            <div>
              <label className="block text-xs text-ctp-subtext0 mb-1">Save scope</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                disabled={saving}
                className="w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus-ring"
              >
                {scopeOptions.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          )}
          {error && <p className="text-xs text-ctp-error">{error}</p>}
          <div className="flex flex-wrap gap-2">
            {mode === 'edit' && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || loading}
                className="text-xs px-3 py-1 rounded bg-ctp-accent text-white hover:bg-ctp-accent/80 cursor-pointer transition-colors disabled:opacity-50"
                title={`Overwrite "${value}"`}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            <button
              type="button"
              onClick={handleSaveAsCopy}
              disabled={saving || loading}
              className="text-xs px-3 py-1 rounded bg-ctp-accent text-white hover:bg-ctp-accent/80 cursor-pointer transition-colors disabled:opacity-50"
            >
              {mode === 'new' ? (saving ? 'Creating…' : `Create ${noun}`) : 'Save as new copy'}
            </button>
            {mode === 'edit' && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving || loading}
                className="text-xs px-3 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:text-ctp-error hover:border-ctp-error/50 cursor-pointer transition-colors disabled:opacity-50"
                title={`Delete the "${value}" ${noun} file`}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={close}
              disabled={saving}
              className="text-xs px-3 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
