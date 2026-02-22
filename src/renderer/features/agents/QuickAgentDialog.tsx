import { useState, useEffect, useRef } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

export function QuickAgentDialog() {
  const isOpen = useUIStore((s) => s.quickAgentDialogOpen);
  const closeDialog = useUIStore((s) => s.closeQuickAgentDialog);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const agents = useAgentStore((s) => s.agents);
  const spawnQuickAgent = useAgentStore((s) => s.spawnQuickAgent);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);

  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));

  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [parentAgentId, setParentAgentId] = useState<string>('');
  const [orchestrator, setOrchestrator] = useState('');
  const [model, setModel] = useState('default');
  const [freeAgentMode, setFreeAgentMode] = useState(false);
  const [mission, setMission] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { options: MODEL_OPTIONS } = useModelOptions(orchestrator || undefined);

  // Reset form state when dialog opens
  useEffect(() => {
    if (isOpen) {
      const projId = activeProjectId || projects[0]?.id || '';
      setSelectedProjectId(projId);
      setParentAgentId('');
      setOrchestrator(enabledOrchestrators[0]?.id || '');
      setModel('default');
      setFreeAgentMode(false);
      setMission('');
      // Focus the text input after a tick
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  // Durable agents for the selected project
  const durableAgents = Object.values(agents).filter(
    (a) => a.projectId === selectedProjectId && a.kind === 'durable'
  );

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  // Resolve orchestrator for capabilities check
  const resolvedOrchId = parentAgentId
    ? agents[parentAgentId]?.orchestrator || enabledOrchestrators[0]?.id
    : orchestrator || enabledOrchestrators[0]?.id;
  const resolvedOrch = allOrchestrators.find((o) => o.id === resolvedOrchId);
  const supportsPermissions = resolvedOrch?.capabilities?.permissions ?? false;

  const handleSubmit = async () => {
    if (!selectedProject || !mission.trim()) return;
    const parentId = parentAgentId || undefined;
    const selectedOrchestrator = (!parentId && orchestrator) ? orchestrator : undefined;
    const freeMode = freeAgentMode || undefined;
    closeDialog();

    // Navigate to the project's agent view
    setActiveProject(selectedProject.id);
    setExplorerTab('agents', selectedProject.id);

    try {
      await spawnQuickAgent(
        selectedProject.id,
        selectedProject.path,
        mission.trim(),
        model,
        parentId,
        selectedOrchestrator,
        freeMode,
      );
    } catch (err) {
      console.error('Failed to spawn quick agent:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && mission.trim()) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      closeDialog();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={closeDialog}>
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[420px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h2 className="text-base font-semibold text-ctp-text mb-4">New Quick Agent</h2>

        {/* Project */}
        <label className="block mb-3">
          <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Project</span>
          <select
            value={selectedProjectId}
            onChange={(e) => { setSelectedProjectId(e.target.value); setParentAgentId(''); }}
            className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
              text-ctp-text focus:outline-none focus:border-indigo-500"
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.displayName || p.name}</option>
            ))}
          </select>
        </label>

        {/* Parent Durable Agent */}
        <label className="block mb-3">
          <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Parent Agent</span>
          <select
            value={parentAgentId}
            onChange={(e) => setParentAgentId(e.target.value)}
            className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
              text-ctp-text focus:outline-none focus:border-indigo-500"
          >
            <option value="">None (project root)</option>
            {durableAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>

        {/* Orchestrator (hidden when a parent is selected, inherits parent's orchestrator) */}
        {!parentAgentId && enabledOrchestrators.length > 0 && (
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Orchestrator</span>
            <select
              value={orchestrator || enabledOrchestrators[0]?.id}
              onChange={(e) => { setOrchestrator(e.target.value); setModel('default'); }}
              className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                text-ctp-text focus:outline-none focus:border-indigo-500"
            >
              {enabledOrchestrators.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName}</option>
              ))}
            </select>
          </label>
        )}

        {/* Model */}
        <label className="block mb-3">
          <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Model</span>
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
        </label>

        {/* Free Agent Mode */}
        <label
          className={`flex items-center gap-2 mb-4 ${supportsPermissions ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
          title={supportsPermissions ? 'Skip all permission prompts' : 'Not supported by this orchestrator'}
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

        {/* Prompt */}
        <label className="block mb-4">
          <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Prompt</span>
          <textarea
            ref={inputRef}
            value={mission}
            onChange={(e) => setMission(e.target.value)}
            placeholder="What should this quick agent do?"
            rows={3}
            className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-2 text-sm
              text-ctp-text placeholder:text-ctp-overlay0
              focus:outline-none focus:border-indigo-500 resize-none"
          />
          <span className="text-[10px] text-ctp-overlay0 mt-0.5 block">
            {navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to submit
          </span>
        </label>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeDialog}
            className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
              hover:bg-surface-2 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!mission.trim() || !selectedProjectId}
            className="px-4 py-1.5 text-xs rounded bg-indigo-500 text-white
              hover:bg-indigo-600 cursor-pointer font-medium
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Start Agent
          </button>
        </div>
      </div>
    </div>
  );
}
