import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../../components/Modal';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { parsePersonaFile, PatternSettings, PATTERN_SETTING_KEYS } from '../../../shared/persona-pattern';

interface PersonaOption {
  id: string;
  name: string;
  source: 'builtin' | 'user' | 'project';
}

/** Human-readable summary of a settings value for the confirmation preview. */
function formatSettingValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return Object.keys(value).join(', ');
  return String(value);
}

/**
 * "Apply persona" dialog — pick an existing persona (built-in / user / project)
 * and apply it to the right-clicked agent, overwriting its persona, instructions,
 * and any settings the persona carries in its front-matter.
 */
export function ApplyPersonaDialog() {
  const applyPersonaDialogAgent = useAgentStore((s) => s.applyPersonaDialogAgent);
  const closeApplyPersonaDialog = useAgentStore((s) => s.closeApplyPersonaDialog);
  const agents = useAgentStore((s) => s.agents);
  const loadDurableAgents = useAgentStore((s) => s.loadDurableAgents);
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const agent = applyPersonaDialogAgent ? agents[applyPersonaDialogAgent] : null;

  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [previewSettings, setPreviewSettings] = useState<PatternSettings>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  const projectPath = activeProject?.path;

  // Load the available personas when the dialog opens.
  useEffect(() => {
    if (!applyPersonaDialogAgent || !projectPath) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await window.clubhouse.agentSettings.listSourcePersonas(projectPath);
        if (!cancelled) setPersonas(list);
      } catch {
        if (!cancelled) setPersonas([]);
      }
    })();
    return () => { cancelled = true; };
  }, [applyPersonaDialogAgent, projectPath]);

  // Preview the settings carried by the selected persona's front-matter.
  useEffect(() => {
    if (!selectedId || !projectPath) { setPreviewSettings({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const raw = await window.clubhouse.agentSettings.readSourcePersonaContent(projectPath, selectedId);
        if (!cancelled) setPreviewSettings(parsePersonaFile(raw).settings);
      } catch {
        if (!cancelled) setPreviewSettings({});
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, projectPath]);

  const settingKeys = useMemo(
    () => PATTERN_SETTING_KEYS.filter((k) => previewSettings[k] !== undefined),
    [previewSettings],
  );

  if (!agent || !projectPath || !applyPersonaDialogAgent) return null;

  const handleApply = async () => {
    if (!selectedId) return;
    setApplying(true);
    setError('');
    try {
      await window.clubhouse.agentSettings.applyPersonaToAgent(projectPath, applyPersonaDialogAgent, selectedId);
      if (activeProject) await loadDurableAgents(activeProject.id, projectPath);
      closeApplyPersonaDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply persona.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal open onClose={closeApplyPersonaDialog} title={`Apply persona to ${agent.name}`} width="w-[440px]">
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Persona</label>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="w-full bg-surface-0 border border-surface-2 rounded px-2 py-1.5 text-sm text-ctp-text focus-ring"
          >
            <option value="">Select a persona…</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.source !== 'builtin' ? ` · ${p.source}` : ''}
              </option>
            ))}
          </select>
        </div>

        {selectedId && (
          <div className="text-xs text-ctp-subtext0 bg-ctp-mantle border border-surface-0 rounded-lg px-3 py-2 space-y-1">
            <p>
              Applying overwrites <span className="text-ctp-text">{agent.name}</span>&apos;s persona and instructions.
            </p>
            {settingKeys.length > 0 ? (
              <div>
                <p className="text-ctp-subtext0/80">It also overwrites these settings:</p>
                <ul className="mt-1 space-y-0.5">
                  {settingKeys.map((k) => (
                    <li key={k} className="font-mono text-ctp-subtext0">
                      {k}: <span className="text-ctp-text">{formatSettingValue(previewSettings[k])}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-ctp-subtext0/80">This persona carries no extra settings (instructions only).</p>
            )}
            {agent.status === 'running' && (
              <p className="text-ctp-warning">Agent is running — changes take effect on its next wake.</p>
            )}
          </div>
        )}

        {error && <p className="text-xs text-ctp-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={closeApplyPersonaDialog}
            disabled={applying}
            className="text-xs px-3 py-1.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!selectedId || applying}
            className="text-xs px-3 py-1.5 rounded bg-ctp-accent text-white hover:bg-ctp-accent/80 cursor-pointer transition-colors disabled:opacity-50"
          >
            {applying ? 'Applying…' : 'Apply persona'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
