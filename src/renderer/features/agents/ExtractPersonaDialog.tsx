import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../../components/Modal';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { serializePersonaFile, PatternSettings, PATTERN_SETTING_KEYS } from '../../../shared/persona-persona';

const ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
}

function formatSettingValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * "Extract persona" dialog — capture the right-clicked agent's instructions
 * (re-genericized with @@wildcards) and a chosen subset of its settings into a
 * reusable persona file, saved to the user-global or project persona library.
 */
export function ExtractPersonaDialog() {
  const extractPersonaDialogAgent = useAgentStore((s) => s.extractPersonaDialogAgent);
  const closeExtractPersonaDialog = useAgentStore((s) => s.closeExtractPersonaDialog);
  const agents = useAgentStore((s) => s.agents);
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const agent = extractPersonaDialogAgent ? agents[extractPersonaDialogAgent] : null;
  const projectPath = activeProject?.path;

  const [content, setContent] = useState('');
  const [settings, setSettings] = useState<PatternSettings>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [id, setId] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load the extracted persona when the dialog opens.
  useEffect(() => {
    if (!extractPersonaDialogAgent || !projectPath) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const result = await window.clubhouse.agentSettings.extractAgentPersona(projectPath, extractPersonaDialogAgent);
        if (cancelled) return;
        const s = (result?.settings ?? {}) as PatternSettings;
        setContent(result?.content ?? '');
        setSettings(s);
        setChecked(new Set(PATTERN_SETTING_KEYS.filter((k) => s[k] !== undefined)));
      } catch {
        if (!cancelled) { setContent(''); setSettings({}); setChecked(new Set()); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [extractPersonaDialogAgent, projectPath]);

  // Seed the default id from the agent name when the dialog opens.
  useEffect(() => {
    if (agent) setId(slugify(agent.name));
  }, [agent]);

  const presentKeys = useMemo(
    () => PATTERN_SETTING_KEYS.filter((k) => settings[k] !== undefined),
    [settings],
  );

  if (!agent || !projectPath || !extractPersonaDialogAgent) return null;

  const toggle = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleSave = async () => {
    const trimmed = id.trim();
    if (!trimmed) { setError('Enter an id for the persona.'); return; }
    if (!ID_PATTERN.test(trimmed)) { setError('Use only letters, numbers, dots, dashes, and underscores.'); return; }
    setSaving(true);
    setError('');
    try {
      const chosen: PatternSettings = {};
      for (const key of PATTERN_SETTING_KEYS) {
        if (checked.has(key) && settings[key] !== undefined) {
          (chosen as Record<string, unknown>)[key] = settings[key];
        }
      }
      const file = serializePersonaFile(chosen, content);
      await window.clubhouse.agentSettings.writeSourcePersonaContent(projectPath, trimmed, file, scope);
      closeExtractPersonaDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save persona.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={closeExtractPersonaDialog} title={`Extract persona from ${agent.name}`} width="w-[520px]">
      <div className="space-y-4">
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs text-ctp-subtext0 mb-1">Pattern id</label>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="my-persona"
              className="w-full bg-surface-0 border border-surface-2 rounded px-2 py-1.5 text-sm text-ctp-text placeholder:text-ctp-overlay0 focus-ring"
            />
          </div>
          <div className="w-44">
            <label className="block text-xs text-ctp-subtext0 mb-1">Save to</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'user' | 'project')}
              className="w-full bg-surface-0 border border-surface-2 rounded px-2 py-1.5 text-sm text-ctp-text focus-ring"
            >
              <option value="user">All my projects</option>
              <option value="project">This project</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Instructions (persona body)</label>
          <textarea
            value={loading ? 'Loading…' : content}
            onChange={(e) => setContent(e.target.value)}
            disabled={loading || saving}
            spellCheck={false}
            placeholder="This agent has no instructions to capture."
            className="w-full h-44 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-2 resize-y border border-surface-1 focus-ring"
          />
        </div>

        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Settings to include</label>
          {presentKeys.length === 0 ? (
            <p className="text-xs text-ctp-subtext0/60">This agent has no extra settings to capture.</p>
          ) : (
            <div className="grid grid-cols-2 gap-1">
              {presentKeys.map((k) => (
                <label key={k} className="flex items-center gap-2 text-xs text-ctp-text cursor-pointer py-0.5">
                  <input
                    type="checkbox"
                    checked={checked.has(k)}
                    onChange={() => toggle(k)}
                    className="w-3.5 h-3.5 rounded border-surface-2 bg-surface-0 accent-ctp-accent"
                  />
                  <span className="font-mono truncate" title={`${k}: ${formatSettingValue(settings[k])}`}>
                    {k} <span className="text-ctp-subtext0/70">= {formatSettingValue(settings[k])}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-ctp-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={closeExtractPersonaDialog}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="text-xs px-3 py-1.5 rounded bg-ctp-accent text-white hover:bg-ctp-accent/80 cursor-pointer transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save persona'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
