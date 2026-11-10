import { parseMcpJson } from '../../../shared/mcp-config';
import { useEffect, useState, useCallback, useRef } from 'react';
import { SettingsMonacoEditor } from '../../components/SettingsMonacoEditor';
import { Button } from '../../components/Button';
import { useReportDirty, useSaveBarSlot, type SaveHandle } from './agentSettingsPages';

/** Servers in an .mcp.json text, or undefined when it doesn't parse. */
function countServers(raw: string): number | undefined {
  try {
    return Object.keys(parseMcpJson(raw)).length;
  } catch {
    // telemetry-exempt: invalid JSON is shown in the editor; it only means no count
    return undefined;
  }
}

interface Props {
  worktreePath: string;
  agentId?: string;
  projectPath?: string;
  disabled: boolean;
  refreshKey: number;
  pathLabel?: string;
  /** The page title already names the section (agent settings pages in the new chrome). */
  hideTitle?: boolean;
  /** Whether the editor holds unsaved edits. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Joins the agent settings save bar; the section then drops its own Save button. */
  onRegisterSave?: (handle: SaveHandle | null) => void;
  /** Servers in the saved file, for the sidebar. */
  onCountChange?: (count: number) => void;
}

export function McpJsonSection({ worktreePath, projectPath, agentId, disabled, refreshKey, pathLabel, hideTitle, onDirtyChange, onRegisterSave, onCountChange }: Props) {
  const target = JSON.stringify([worktreePath, projectPath, agentId, pathLabel, refreshKey]);
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const requests = useRef(0);
  const pendingSave = useRef<{ target: string; request: number; token: symbol } | null>(null);
  const [loadedTarget, setLoadedTarget] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadContent = useCallback(async () => {
    if (!worktreePath) return;
    const request = ++requests.current;
    const current = () => requests.current === request && currentTarget.current === target;
    setLoaded(false);
    setDirty(false);
    setSaving(false);
    setContent('');
    setError(null);
    setWarning(null);
    try {
      const [raw, shadowWarning] = await Promise.all([
        window.clubhouse.agentSettings.readMcpRawJson(worktreePath, projectPath, agentId),
        window.clubhouse.agentSettings.getMcpShadowWarning(worktreePath, projectPath, agentId),
      ]);
      if (!current()) return;
      setLoadedTarget(target);
      setReadFailed(false);
      setContent(raw);
      const count = countServers(raw);
      if (count !== undefined) onCountChange?.(count);
      setWarning(shadowWarning ?? null);
      setLoaded(true);
      setDirty(false);
      try { parseMcpJson(raw); setError(null); } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid MCP configuration');
      }
    } catch (err) {
      if (!current()) return;
      setLoadedTarget(target);
      setReadFailed(true);
      setWarning(null);
      setLoaded(true);
      setDirty(false);
      setError(err instanceof Error ? err.message : 'Failed to read MCP config');
    }
  }, [worktreePath, projectPath, agentId, target, onCountChange]);

  useEffect(() => {
    void loadContent();
    return () => { requests.current++; };
  }, [loadContent]);

  const handleChange = (value: string) => {
    if (pendingSave.current?.target === target && pendingSave.current.request === requests.current) return;
    setContent(value);
    setDirty(true);
    // Live JSON validation
    try {
      parseMcpJson(value);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  /** Throws when the file can't be written, so the save bar can say so. */
  const handleSave = async () => {
    if (!worktreePath || !dirty || readFailed || !loaded || loadedTarget !== target) return;
    const request = requests.current;
    if (pendingSave.current?.target === target && pendingSave.current.request === request) return;
    const current = () => requests.current === request && currentTarget.current === target;
    if (countServers(content) === undefined) throw new Error(error || 'Invalid JSON');
    const token = Symbol('mcp-save');
    pendingSave.current = { target, request, token };
    setSaving(true);
    try {
      const result = await window.clubhouse.agentSettings.writeMcpRawJson(worktreePath, content, projectPath, agentId);
      if (!current()) return;
      if (!result.ok) {
        setError(result.error || 'Failed to save');
        throw new Error(result.error || 'Failed to save');
      }
      setDirty(false);
      setError(null);
      const count = countServers(content);
      if (count !== undefined) onCountChange?.(count);
    } catch (err) {
      if (!current()) return;
      setError(err instanceof Error ? err.message : 'Failed to save MCP configuration');
      throw err;
    } finally {
      if (pendingSave.current?.token === token) pendingSave.current = null;
      if (current()) setSaving(false);
    }
  };

  // The section's own Save button keeps its old behaviour: failures show under the editor.
  const handleOwnSave = () => {
    handleSave().catch(() => { /* telemetry-exempt: the error is shown under the editor */ });
  };

  useReportDirty(onDirtyChange, dirty);
  useSaveBarSlot(onRegisterSave, handleSave, () => { void loadContent(); });

  if (!loaded || loadedTarget !== target) return null;

  return (
    <section className={hideTitle ? 'mt-3' : 'mt-[22px]'}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          {!hideTitle && <h3 className="text-[13px] font-semibold text-ctp-text">MCP servers</h3>}
          <span className="text-xs text-ctp-overlay1 font-mono">{pathLabel || '.mcp.json'}</span>
        </div>
        {!onRegisterSave && (
          <Button kind={dirty && !error ? 'primary' : 'ghost'} onClick={handleOwnSave} disabled={disabled || !dirty || saving || !!error}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>

      <p className="text-xs text-ctp-overlay1 mb-2">
        Saved entries configure the next start; they do not prove delivery or connection.
        A missing local file gets the project's legacy MCP servers (shown read-only in the project's settings). Save an empty mcpServers object to use no local servers.
        The live Clubhouse bridge follows its separate MCP setting.
      </p>
      <SettingsMonacoEditor
        value={content}
        language="json"
        onChange={handleChange}
        readOnly={disabled || readFailed || saving}
        height="200px"
        editorKey="mcp-json"
      />

      {warning && (
        <div className="mt-1.5 flex items-start gap-1.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-warning flex-shrink-0 mt-0.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-xs text-ctp-warning">{warning}</span>
        </div>
      )}

      {error && (
        <div className="mt-1.5 flex items-start gap-1.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-error flex-shrink-0 mt-0.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-xs text-ctp-error">{error}</span>
        </div>
      )}
    </section>
  );
}
