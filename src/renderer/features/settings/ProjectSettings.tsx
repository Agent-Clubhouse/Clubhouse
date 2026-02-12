import { useEffect, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { ProjectSettings as ProjectSettingsType } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';

function AppearanceSection() {
  const { projects, activeProjectId, projectIcons, updateProject, pickProjectIcon } = useProjectStore();
  const project = projects.find((p) => p.id === activeProjectId);
  if (!project) return null;

  const iconDataUrl = projectIcons[project.id];
  const hasImage = !!project.icon && !!iconDataUrl;
  const colorInfo = project.color ? AGENT_COLORS.find((c) => c.id === project.color) : null;
  const hex = colorInfo?.hex || '#6366f1';

  return (
    <div className="space-y-4 mb-6">
      <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Appearance</h3>

      {/* Icon */}
      <div>
        <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">Icon</label>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0"
            style={hasImage ? undefined : { backgroundColor: `${hex}20`, color: hex }}
          >
            {hasImage ? (
              <img src={iconDataUrl} alt={project.name} className="w-full h-full object-cover" />
            ) : (
              <span className="text-xl font-bold">{project.name.charAt(0).toUpperCase()}</span>
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

      <div className="border-t border-surface-2" />
    </div>
  );
}

export function ProjectSettings() {
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [settings, setSettings] = useState<ProjectSettingsType>({
    defaultClaudeMd: '',
    quickAgentClaudeMd: '',
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!activeProject) return;
    window.clubhouse.agent.getSettings(activeProject.path).then(setSettings);
  }, [activeProject]);

  const handleSave = async () => {
    if (!activeProject) return;
    await window.clubhouse.agent.saveSettings(activeProject.path, settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!activeProject) {
    return <div className="p-4 text-ctp-subtext0 text-sm">Select a project</div>;
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Project Settings</h2>

        <AppearanceSection />

        <div className="space-y-5">
          <div>
            <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
              Default CLAUDE.md for new agents
            </label>
            <textarea
              value={settings.defaultClaudeMd}
              onChange={(e) => setSettings({ ...settings, defaultClaudeMd: e.target.value })}
              placeholder="# Instructions for Claude agents in this project..."
              rows={10}
              className="w-full bg-surface-0 border border-surface-2 rounded-lg px-3 py-2 text-sm text-ctp-text
                font-mono placeholder-ctp-subtext0/50 resize-y focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
              Default CLAUDE.md for quick agents
            </label>
            <textarea
              value={settings.quickAgentClaudeMd}
              onChange={(e) => setSettings({ ...settings, quickAgentClaudeMd: e.target.value })}
              placeholder="# Instructions for quick/ephemeral sessions..."
              rows={6}
              className="w-full bg-surface-0 border border-surface-2 rounded-lg px-3 py-2 text-sm text-ctp-text
                font-mono placeholder-ctp-subtext0/50 resize-y focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm rounded-lg bg-indigo-500 text-white
                hover:bg-indigo-600 cursor-pointer font-medium"
            >
              Save Settings
            </button>
            {saved && <span className="text-xs text-green-300">Saved!</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
