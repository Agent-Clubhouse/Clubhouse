import { useState, useEffect } from 'react';
import { generateDurableName, AGENT_COLORS } from '../../../shared/name-generator';
import { validateAgentGitName } from '../../../shared/agent-name';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { newAgentOrchestrator } from './effective-orchestrator';
import { useEffectiveOrchestrators } from '../../hooks/useEffectiveOrchestrators';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/Spinner';
import type { McpCatalogEntry } from '../../../shared/types';
import type { AccessLevel } from '../../../shared/agent-access';
import { AccessSelect, accessHelp, useDefaultAccess } from './AccessSelect';

interface Props {
  onClose: () => void;
  onCreate: (name: string, color: string, model: string, useWorktree: boolean, orchestrator?: string, access?: AccessLevel, mcpIds?: string[]) => void;
  projectPath?: string;
  /** Surfaced when the most recent create attempt failed, so the user sees why instead of a silently dead button. */
  error?: string | null;
}

export function AddAgentDialog({ onClose, onCreate, projectPath, error }: Props) {
  const [name, setName] = useState(generateDurableName());
  const [color, setColor] = useState<string>(AGENT_COLORS[0].id);
  const [model, setModel] = useState('default');
  const [useWorktree, setUseWorktree] = useState(false);
  // Access (#2761): the app's Default access until the person picks one.
  const defaultAccess = useDefaultAccess();
  const [pickedAccess, setPickedAccess] = useState<AccessLevel | null>(null);
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [selectedMcps, setSelectedMcps] = useState<string[]>([]);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const availability = useOrchestratorStore((s) => s.availability);
  const { effectiveOrchestrators: enabledOrchestrators } = useEffectiveOrchestrators();
  // Starts on the project's "Agents run on" (#2975).
  const project = useProjectStore((s) => s.projects.find((p) => p.path === projectPath));
  const [orchestrator, setOrchestrator] = useState(() => newAgentOrchestrator(project, enabledOrchestrators));
  const selectedAvail = availability[orchestrator];
  const { options: MODEL_OPTIONS, loading: modelsLoading } = useModelOptions(orchestrator);

  const selectedOrch = allOrchestrators.find((o) => o.id === orchestrator);
  const supportsPermissions = selectedOrch?.capabilities?.permissions ?? false;
  // A CLI without permission support starts at Ask first.
  const access: AccessLevel = supportsPermissions ? pickedAccess ?? defaultAccess : 'ask';

  useEffect(() => {
    if (!projectPath) return;
    Promise.all([
      window.clubhouse.project.readMcpCatalog(projectPath),
      window.clubhouse.project.readDefaultMcps(projectPath),
    ]).then(([catalog, defaults]) => {
      setMcpCatalog(catalog || []);
      setSelectedMcps(defaults || []);
    }).catch(() => {
      // MCP catalog load failed — leave defaults (empty catalog, no selected MCPs)
    });
  }, [projectPath]);

  // With a worktree the name becomes a folder and a git branch, so it must be strict.
  const nameProblem = useWorktree && name.trim() ? validateAgentGitName(name.trim(), 'folder') : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || nameProblem) return;
    onCreate(name.trim(), color, model, useWorktree, orchestrator, access, selectedMcps.length > 0 ? selectedMcps : undefined);
  };

  return (
    <Modal open={true} onClose={onClose} aria-label="New agent">
        <h2 className="text-base font-semibold text-ctp-text mb-4">New Agent</h2>
        {error && (
          <div
            className="px-3 py-2 mb-3 text-xs text-ctp-error bg-ctp-error/10 rounded-md"
            data-testid="add-agent-dialog-error"
          >
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          {/* Name */}
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Name</span>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={nameProblem ? true : undefined}
                aria-describedby={nameProblem ? 'add-agent-name-error' : undefined}
                className="flex-1 bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                  text-ctp-text focus-ring"
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
            {nameProblem && (
              <p id="add-agent-name-error" className="mt-1 text-xs text-ctp-error" data-testid="add-agent-name-error">{nameProblem}</p>
            )}
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
                <Spinner size="xs" />
                Loading models…
              </div>
            ) : (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                  text-ctp-text focus-ring"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            )}
          </label>

          {/* Orchestrator */}
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Runs on</span>
            <select
              value={orchestrator}
              onChange={(e) => { setOrchestrator(e.target.value); setModel('default'); }}
              className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                text-ctp-text focus-ring"
            >
              {enabledOrchestrators.map((o) => {
                const avail = availability[o.id];
                const suffix = avail && !avail.available ? ' (not found)' : '';
                return <option key={o.id} value={o.id}>{o.displayName}{suffix}</option>;
              })}
            </select>
            {selectedAvail && !selectedAvail.available && (
              <p className="mt-1 text-xs text-status-warning">
                ⚠ {selectedAvail.error || 'CLI not found — agent may fail to start'}
              </p>
            )}
          </label>

          {/* Use Worktree */}
          <label className="flex items-center gap-2 mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
              className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-ctp-accent focus:ring-ctp-accent"
            />
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Use git worktree</span>
            <span className="text-xs text-ctp-subtext0/70 ml-1">
              (isolated branch + directory)
            </span>
          </label>

          {/* Access */}
          <div className="block mb-4">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Access</span>
            <AccessSelect
              value={access}
              onChange={setPickedAccess}
              providerId={orchestrator}
              disabled={!supportsPermissions}
              data-testid="add-agent-access"
              className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                text-ctp-text focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <p className="mt-1 text-xs text-ctp-subtext0/70">
              {supportsPermissions ? accessHelp(access) : 'Not supported by this CLI.'}
            </p>
          </div>

          {/* MCPs (only when catalog is available) */}
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
                      className="w-3.5 h-3.5 rounded border-surface-2 bg-surface-0 text-ctp-accent focus:ring-ctp-accent"
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
              disabled={!!nameProblem}
              className="px-4 py-1.5 text-xs rounded bg-ctp-accent text-white
                hover:bg-ctp-accent/80 cursor-pointer font-medium
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Create Agent
            </button>
          </div>
        </form>
    </Modal>
  );
}
