import { useState, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { ResetProjectDialog } from './ResetProjectDialog';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

function NameAndPathSection({ projectId }: { projectId: string }) {
  const { projects, updateProject } = useProjectStore();
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;

  const currentName = project.displayName || project.name;
  const [value, setValue] = useState(currentName);
  const dirty = value.trim() !== currentName;

  // Sync if project changes externally
  useEffect(() => {
    setValue(project.displayName || project.name);
  }, [project.displayName, project.name]);

  const save = () => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === project.name) {
      updateProject(project.id, { displayName: '' });
    } else {
      updateProject(project.id, { displayName: trimmed });
    }
  };

  return (
    <div className="space-y-2 mb-6">
      <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider">Name</label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          placeholder={project.name}
          className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
            text-ctp-text placeholder:text-ctp-subtext0/40
            focus:outline-none focus:border-ctp-accent/50 focus:ring-1 focus:ring-ctp-accent/30"
        />
        {dirty && (
          <button
            onClick={save}
            className="px-3 py-1.5 text-xs rounded-lg bg-indigo-500/20 border border-indigo-500/40
              text-indigo-400 hover:bg-indigo-500/30 cursor-pointer transition-colors"
          >
            Save
          </button>
        )}
      </div>
      <p className="text-xs text-ctp-subtext0 font-mono truncate" title={project.path}>{project.path}</p>
    </div>
  );
}

function AppearanceSection({ projectId }: { projectId: string }) {
  const { projects, projectIcons, updateProject, pickProjectIcon } = useProjectStore();
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;

  const iconDataUrl = projectIcons[project.id];
  const hasImage = !!project.icon && !!iconDataUrl;
  const colorInfo = project.color ? AGENT_COLORS.find((c) => c.id === project.color) : null;
  const hex = colorInfo?.hex || '#6366f1';
  const label = project.displayName || project.name;

  return (
    <div className="space-y-4 mb-6">
      {/* Icon */}
      <div>
        <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">Icon</label>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0"
            style={hasImage ? undefined : { backgroundColor: `${hex}20`, color: hex }}
          >
            {hasImage ? (
              <img src={iconDataUrl} alt={label} className="w-full h-full object-cover" />
            ) : (
              <span className="text-xl font-bold">{label.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <button
            onClick={() => pickProjectIcon(project.id)}
            className="px-3 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2
              text-ctp-text hover:bg-surface-1 cursor-pointer transition-colors"
          >
            Choose Image
          </button>
          {hasImage && (
            <button
              onClick={() => updateProject(project.id, { icon: '' })}
              className="px-3 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2
                text-ctp-subtext0 hover:text-red-400 hover:border-red-400/50 cursor-pointer transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Color */}
      <div>
        <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">Color</label>
        <div className="flex items-center gap-2">
          {AGENT_COLORS.map((c) => {
            const isSelected = project.color === c.id || (!project.color && c.id === 'indigo');
            return (
              <button
                key={c.id}
                title={c.label}
                onClick={() => updateProject(project.id, { color: c.id })}
                className={`
                  w-7 h-7 rounded-full flex items-center justify-center cursor-pointer
                  transition-all duration-150
                  ${isSelected ? 'ring-2 ring-offset-2 ring-offset-ctp-base' : 'hover:scale-110'}
                `}
                style={{
                  backgroundColor: c.hex,
                  ...(isSelected ? { ringColor: c.hex } : {}),
                }}
              >
                {isSelected && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function OrchestratorSection({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const { projects, updateProject } = useProjectStore();
  const project = projects.find((p) => p.id === projectId);
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));

  if (!project || enabledOrchestrators.length <= 1) return null;

  const current = project.orchestrator || 'claude-code';

  return (
    <div className="space-y-2 mb-6">
      <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Agent Backend</h3>
      <select
        value={current}
        onChange={(e) => updateProject(project.id, { orchestrator: e.target.value })}
        className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
          text-ctp-text focus:outline-none focus:border-ctp-accent/50"
      >
        {enabledOrchestrators.map((o) => (
          <option key={o.id} value={o.id}>{o.displayName}</option>
        ))}
      </select>
      <p className="text-xs text-ctp-subtext0">
        Default orchestrator for agents in this project. Individual agents can override.
      </p>
    </div>
  );
}

function DangerZone({ projectId, projectPath, projectName }: { projectId: string; projectPath: string; projectName: string }) {
  const removeProject = useProjectStore((s) => s.removeProject);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const [showResetDialog, setShowResetDialog] = useState(false);

  const handleClose = () => {
    toggleSettings();
    removeProject(projectId);
  };

  const handleReset = async () => {
    await window.clubhouse.project.resetProject(projectPath);
    toggleSettings();
    removeProject(projectId);
  };

  return (
    <>
      <div className="rounded-lg border border-red-500/30 p-4 space-y-3">
        <h3 className="text-xs text-red-400 uppercase tracking-wider">Danger Zone</h3>
        <div className="flex items-center gap-3">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm rounded-lg bg-surface-0 border border-surface-2
              text-ctp-subtext1 hover:bg-surface-1 hover:text-ctp-text cursor-pointer transition-colors"
          >
            Close Project
          </button>
          <button
            onClick={() => setShowResetDialog(true)}
            className="px-4 py-2 text-sm rounded-lg bg-red-500/10 border border-red-500/30
              text-red-400 hover:bg-red-500/20 cursor-pointer transition-colors"
          >
            Reset Project
          </button>
        </div>
        <p className="text-xs text-ctp-subtext0">
          Close removes the project from Clubhouse. Reset also deletes all <span className="font-mono">.clubhouse/</span> data.
        </p>
      </div>

      {showResetDialog && (
        <ResetProjectDialog
          projectName={projectName}
          projectPath={projectPath}
          onConfirm={handleReset}
          onCancel={() => setShowResetDialog(false)}
        />
      )}
    </>
  );
}

export function ProjectSettings({ projectId }: { projectId?: string }) {
  const { projects, activeProjectId } = useProjectStore();
  const id = projectId ?? activeProjectId;
  const project = projects.find((p) => p.id === id);

  if (!project) {
    return <div className="p-4 text-ctp-subtext0 text-sm">Select a project</div>;
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Project Settings</h2>
        <NameAndPathSection projectId={project.id} />
        <AppearanceSection projectId={project.id} />
        <OrchestratorSection projectId={project.id} projectPath={project.path} />
        <DangerZone projectId={project.id} projectPath={project.path} projectName={project.displayName || project.name} />
      </div>
    </div>
  );
}
