import { useState, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { usePluginStore } from '../../stores/pluginStore';
import { useUIStore } from '../../stores/uiStore';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { ResetProjectDialog } from './ResetProjectDialog';

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

const TOGGLEABLE_TABS = [
  {
    id: 'agents',
    label: 'Agents',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="4" />
        <circle cx="9" cy="16" r="1.5" fill="currentColor" />
        <circle cx="15" cy="16" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'hub',
    label: 'Hub',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L8 8H4l2 6H4l8 8 8-8h-2l2-6h-4L12 2z" />
        <line x1="12" y1="22" x2="12" y2="16" />
      </svg>
    ),
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
];

function ViewsSection({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const isCoreTabHidden = usePluginStore((s) => s.isCoreTabHidden);
  const setCoreTabHidden = usePluginStore((s) => s.setCoreTabHidden);

  return (
    <div className="space-y-3 mb-6">
      <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Views</h3>
      {TOGGLEABLE_TABS.map((tab) => {
        const hidden = isCoreTabHidden(projectId, tab.id);
        return (
          <div key={tab.id} className="flex items-center justify-between py-1.5">
            <div className="flex items-center gap-2.5">
              <span className="text-ctp-subtext1">{tab.icon}</span>
              <span className="text-sm text-ctp-text">{tab.label}</span>
            </div>
            <button
              onClick={() => setCoreTabHidden(projectId, projectPath, tab.id, !hidden)}
              className="toggle-track"
              data-on={String(!hidden)}
            >
              <span className="toggle-knob" />
            </button>
          </div>
        );
      })}
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
        <ViewsSection projectId={project.id} projectPath={project.path} />
        <DangerZone projectId={project.id} projectPath={project.path} projectName={project.displayName || project.name} />
      </div>
    </div>
  );
}
