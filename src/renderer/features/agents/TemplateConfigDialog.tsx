import { useState, useEffect } from 'react';
import { generateDurableName, AGENT_COLORS } from '../../../shared/name-generator';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useEffectiveOrchestrators } from '../../hooks/useEffectiveOrchestrators';
import type { PersonaTemplate } from '../assistant/content/personas';
import type { McpCatalogEntry } from '../../../shared/types';

interface Props {
  persona: PersonaTemplate;
  personaColor: string;
  projectPath?: string;
  onClose: () => void;
  onCreate: (config: TemplateConfig) => void;
}

export interface TemplateConfig {
  persona: PersonaTemplate;
  name: string;
  color: string;
  model: string;
  orchestrator: string;
  useWorktree: boolean;
  freeAgentMode: boolean;
  structuredMode: boolean;
  mcpIds?: string[];
}

export function TemplateConfigDialog({ persona, personaColor, projectPath, onClose, onCreate }: Props) {
  const defaultName = persona.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const [name, setName] = useState(defaultName);
  const [color, setColor] = useState(personaColor);
  const [model, setModel] = useState('default');
  const [useWorktree, setUseWorktree] = useState(true);
  const [structuredMode, setStructuredMode] = useState(false);
  const [freeAgentMode, setFreeAgentMode] = useState(false);
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [selectedMcps, setSelectedMcps] = useState<string[]>([]);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const availability = useOrchestratorStore((s) => s.availability);
  const { effectiveOrchestrators: enabledOrchestrators } = useEffectiveOrchestrators(projectPath);
  const [orchestrator, setOrchestrator] = useState(enabledOrchestrators[0]?.id || 'claude-code');
  const selectedAvail = availability[orchestrator];
  const { options: MODEL_OPTIONS, loading: modelsLoading } = useModelOptions(orchestrator);

  const selectedOrch = allOrchestrators.find((o) => o.id === orchestrator);
  const supportsPermissions = selectedOrch?.capabilities?.permissions ?? false;
  const supportsStructured = selectedOrch?.capabilities?.structuredMode ?? false;

  useEffect(() => {
    if (!projectPath) return;
    Promise.all([
      window.clubhouse.project.readMcpCatalog(projectPath),
      window.clubhouse.project.readDefaultMcps(projectPath),
    ]).then(([catalog, defaults]) => {
      setMcpCatalog(catalog || []);
      setSelectedMcps(defaults || []);
    }).catch(() => {});
  }, [projectPath]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate({
      persona,
      name: name.trim(),
      color,
      model,
      orchestrator,
      useWorktree,
      freeAgentMode,
      structuredMode,
      mcpIds: selectedMcps.length > 0 ? selectedMcps : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[360px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Template badge */}
        <div className="flex items-center gap-2 mb-4">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: `${AGENT_COLORS.find((c) => c.id === color)?.hex || '#6366f1'}20` }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-ctp-text">Configure {persona.name}</h2>
            <p className="text-[10px] text-ctp-subtext0">{persona.description}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Name */}
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Name</span>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                  text-ctp-text focus:outline-none focus:border-indigo-500"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setName(generateDurableName())}
                className="px-2 py-1 text-xs rounded bg-surface-1 text-ctp-subtext0
                  hover:bg-surface-2 hover:text-ctp-text cursor-pointer"
                title="Randomize"
              >
                {'\u21BB'}
              </button>
            </div>
          </label>

          {/* Color */}
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Color</span>
            <div className="flex gap-2 mt-1.5">
              {AGENT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setColor(c.id)}
                  className={`w-7 h-7 rounded-full cursor-pointer transition-all ${
                    color === c.id ? 'ring-2 ring-offset-2 ring-offset-ctp-mantle scale-110' : 'opacity-60 hover:opacity-100'
                  }`}
                  style={{ backgroundColor: c.hex, ...(color === c.id ? { boxShadow: `0 0 0 2px ${c.hex}40` } : {}) }}
                  title={c.label}
                />
              ))}
            </div>
          </label>

          {/* Model */}
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Model</span>
            {modelsLoading ? (
              <div className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                text-ctp-subtext0 flex items-center gap-2">
                <span className="inline-block w-3 h-3 border-2 border-ctp-subtext0 border-t-transparent rounded-full animate-spin" />
                Loading models...
              </div>
            ) : (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                  text-ctp-text focus:outline-none focus:border-indigo-500"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            )}
          </label>

          {/* Orchestrator */}
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Orchestrator</span>
            <select
              value={orchestrator}
              onChange={(e) => { setOrchestrator(e.target.value); setModel('default'); }}
              className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                text-ctp-text focus:outline-none focus:border-indigo-500"
            >
              {enabledOrchestrators.map((o) => {
                const avail = availability[o.id];
                const suffix = avail && !avail.available ? ' (not found)' : '';
                return <option key={o.id} value={o.id}>{o.displayName}{suffix}</option>;
              })}
            </select>
            {selectedAvail && !selectedAvail.available && (
              <p className="mt-1 text-xs text-yellow-500">
                {selectedAvail.error || 'CLI not found — agent may fail to start'}
              </p>
            )}
          </label>

          {/* Use Worktree */}
          <label className="flex items-center gap-2 mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
              className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-indigo-500 focus:ring-indigo-500"
            />
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Use git worktree</span>
            <span className="text-[10px] text-ctp-subtext0/70 ml-1">(isolated branch + directory)</span>
          </label>

          {/* Structured Mode */}
          <label
            className={`flex items-center gap-2 mb-3 ${supportsStructured ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
            title={supportsStructured ? 'Run in structured mode with rich event streaming' : 'Not supported by this orchestrator'}
          >
            <input
              type="checkbox"
              checked={structuredMode}
              onChange={(e) => setStructuredMode(e.target.checked)}
              disabled={!supportsStructured}
              className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-indigo-500 focus:ring-indigo-500"
            />
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Use Structured Mode</span>
            <span className="text-[10px] text-ctp-subtext0/70 ml-1">
              {supportsStructured ? '(rich event UI)' : '(not supported)'}
            </span>
          </label>

          {/* Free Agent Mode */}
          <label
            className={`flex items-center gap-2 mb-4 ${supportsPermissions ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
            title={supportsPermissions ? 'Skip all permission prompts when running' : 'Not supported by this orchestrator'}
          >
            <input
              type="checkbox"
              checked={freeAgentMode}
              onChange={(e) => setFreeAgentMode(e.target.checked)}
              disabled={!supportsPermissions}
              className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-red-500 focus:ring-red-500 accent-red-500"
            />
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Free Agent Mode</span>
            <span className="text-[10px] text-ctp-subtext0/70 ml-1">
              {supportsPermissions ? '(skip all permissions)' : '(not supported)'}
            </span>
          </label>

          {/* MCPs */}
          {mcpCatalog.length > 0 && (
            <div className="mb-4">
              <span className="text-xs text-ctp-subtext0 uppercase tracking-wider block mb-1.5">MCPs</span>
              <div className="grid grid-cols-2 gap-1 max-h-32 overflow-y-auto rounded border border-surface-2 p-2 bg-surface-0">
                {mcpCatalog.map((entry) => (
                  <label key={entry.id} className="flex items-center gap-2 py-0.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedMcps.includes(entry.id)}
                      onChange={() => {
                        setSelectedMcps((prev) =>
                          prev.includes(entry.id) ? prev.filter((m) => m !== entry.id) : [...prev, entry.id]
                        );
                      }}
                      className="w-3.5 h-3.5 rounded border-surface-2 bg-surface-0 text-indigo-500 focus:ring-indigo-500"
                    />
                    <span className="text-xs text-ctp-text truncate" title={entry.description}>
                      {entry.name}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
                hover:bg-surface-2 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs rounded bg-indigo-500 text-white
                hover:bg-indigo-600 cursor-pointer font-medium"
            >
              Create Agent
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
