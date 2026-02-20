import { useEffect, useState, useCallback } from 'react';
import { SettingsMonacoEditor } from '../../components/SettingsMonacoEditor';

interface Props {
  worktreePath: string;
  projectPath?: string;
  disabled: boolean;
  refreshKey: number;
  pathLabel?: string;
}

export function McpJsonSection({ worktreePath, projectPath, disabled, refreshKey, pathLabel }: Props) {
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadContent = useCallback(async () => {
    if (!worktreePath) return;
    try {
      const raw = await window.clubhouse.agentSettings.readMcpRawJson(worktreePath, projectPath);
      setContent(raw);
      setLoaded(true);
      setDirty(false);
      setError(null);
    } catch {
      setContent('{\n  "mcpServers": {}\n}');
      setLoaded(true);
    }
  }, [worktreePath, projectPath]);

  useEffect(() => {
    loadContent();
  }, [loadContent, refreshKey]);

  const handleChange = (value: string) => {
    setContent(value);
    setDirty(true);
    // Live JSON validation
    try {
      JSON.parse(value);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  const handleSave = async () => {
    if (!worktreePath || !dirty) return;
    setSaving(true);
    const result = await window.clubhouse.agentSettings.writeMcpRawJson(worktreePath, content, projectPath);
    if (result.ok) {
      setDirty(false);
      setError(null);
    } else {
      setError(result.error || 'Failed to save');
    }
    setSaving(false);
  };

  if (!loaded) return null;

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">MCP Servers</h3>
          <span className="text-[10px] text-ctp-subtext0/60 font-mono">{pathLabel || '.mcp.json'}</span>
        </div>
        <button
          onClick={handleSave}
          disabled={disabled || !dirty || saving || !!error}
          className={`text-xs px-3 py-1 rounded transition-colors ${
            disabled
              ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed'
              : dirty && !error
                ? 'bg-ctp-blue text-white hover:bg-ctp-blue/80 cursor-pointer'
                : 'bg-surface-1 text-ctp-subtext0 cursor-default'
          }`}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      <SettingsMonacoEditor
        value={content}
        language="json"
        onChange={handleChange}
        readOnly={disabled}
        height="200px"
        editorKey="mcp-json"
      />

      {error && (
        <div className="mt-1.5 flex items-start gap-1.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-yellow flex-shrink-0 mt-0.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-[10px] text-ctp-yellow">{error}</span>
        </div>
      )}
    </section>
  );
}
