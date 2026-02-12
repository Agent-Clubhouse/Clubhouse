import { useEffect, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { ProjectSettings as ProjectSettingsType, ConfigLayer, PermissionsConfig } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { PermissionsEditor } from './PermissionsEditor';

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
    defaults: {},
    quickOverrides: {},
  });
  const [localSettings, setLocalSettings] = useState<ConfigLayer>({});
  const [saved, setSaved] = useState(false);
  const [activeSection, setActiveSection] = useState<'defaults' | 'quick' | 'local'>('defaults');

  useEffect(() => {
    if (!activeProject) return;
    window.clubhouse.agent.getSettings(activeProject.path).then(setSettings);
    window.clubhouse.agent.getLocalSettings(activeProject.path).then(setLocalSettings);
  }, [activeProject]);

  const handleSave = async () => {
    if (!activeProject) return;
    await window.clubhouse.agent.saveSettings(activeProject.path, settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSaveLocal = async () => {
    if (!activeProject) return;
    await window.clubhouse.agent.saveLocalSettings(activeProject.path, localSettings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const updateDefaults = (updates: Partial<ConfigLayer>) => {
    setSettings((s) => ({
      ...s,
      defaults: { ...s.defaults, ...updates },
    }));
  };

  const updateQuickOverrides = (updates: Partial<ConfigLayer>) => {
    setSettings((s) => ({
      ...s,
      quickOverrides: { ...s.quickOverrides, ...updates },
    }));
  };

  if (!activeProject) {
    return <div className="p-4 text-ctp-subtext0 text-sm">Select a project</div>;
  }

  const tabs = [
    { key: 'defaults' as const, label: 'Default Configuration' },
    { key: 'quick' as const, label: 'Quick Agent Overrides' },
    { key: 'local' as const, label: 'Personal (.local)' },
  ];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Project Settings</h2>

        <AppearanceSection />

        {/* Section tabs */}
        <div className="flex gap-1 mb-4 border-b border-surface-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveSection(tab.key)}
              className={`px-3 py-2 text-xs font-medium transition-colors cursor-pointer border-b-2 -mb-px ${
                activeSection === tab.key
                  ? 'text-ctp-blue border-ctp-blue'
                  : 'text-ctp-subtext0 border-transparent hover:text-ctp-text'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Default Configuration */}
        {activeSection === 'defaults' && (
          <div className="space-y-5">
            <div>
              <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
                Default CLAUDE.md
              </label>
              <p className="text-[11px] text-ctp-subtext0 mb-2">
                Synced to all agents unless they override it locally.
              </p>
              <textarea
                value={settings.defaults?.claudeMd || ''}
                onChange={(e) => updateDefaults({ claudeMd: e.target.value || undefined })}
                placeholder="# Instructions for Claude agents in this project..."
                rows={10}
                className="w-full bg-surface-0 border border-surface-2 rounded-lg px-3 py-2 text-sm text-ctp-text
                  font-mono placeholder-ctp-subtext0/50 resize-y focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
                Default Permissions
              </label>
              <p className="text-[11px] text-ctp-subtext0 mb-2">
                Permission rules applied to all agents by default.
              </p>
              <PermissionsEditor
                value={settings.defaults?.permissions || {}}
                onChange={(p) => updateDefaults({ permissions: p })}
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
        )}

        {/* Quick Agent Overrides */}
        {activeSection === 'quick' && (
          <div className="space-y-5">
            <div>
              <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
                Quick Agent CLAUDE.md Override
              </label>
              <p className="text-[11px] text-ctp-subtext0 mb-2">
                Additional or replacement instructions for quick/ephemeral agents. Replaces the default CLAUDE.md when set.
              </p>
              <textarea
                value={settings.quickOverrides?.claudeMd || ''}
                onChange={(e) => updateQuickOverrides({ claudeMd: e.target.value || undefined })}
                placeholder="# Instructions for quick/ephemeral sessions..."
                rows={6}
                className="w-full bg-surface-0 border border-surface-2 rounded-lg px-3 py-2 text-sm text-ctp-text
                  font-mono placeholder-ctp-subtext0/50 resize-y focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
                Quick Agent Permissions Override
              </label>
              <PermissionsEditor
                value={settings.quickOverrides?.permissions || {}}
                onChange={(p) => updateQuickOverrides({ permissions: p })}
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
        )}

        {/* Personal (.local) overrides */}
        {activeSection === 'local' && (
          <div className="space-y-5">
            <p className="text-[11px] text-ctp-subtext0">
              Personal overrides stored in <code className="text-ctp-blue">.clubhouse/settings.local.json</code>.
              These merge on top of project defaults and are not shared with others.
            </p>

            <div>
              <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
                Personal CLAUDE.md Override
              </label>
              <textarea
                value={localSettings.claudeMd || ''}
                onChange={(e) => setLocalSettings({ ...localSettings, claudeMd: e.target.value || undefined })}
                placeholder="# Personal instructions override..."
                rows={6}
                className="w-full bg-surface-0 border border-surface-2 rounded-lg px-3 py-2 text-sm text-ctp-text
                  font-mono placeholder-ctp-subtext0/50 resize-y focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
                Personal Permissions Override
              </label>
              <PermissionsEditor
                value={localSettings.permissions || {}}
                onChange={(p) => setLocalSettings({ ...localSettings, permissions: p })}
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveLocal}
                className="px-4 py-2 text-sm rounded-lg bg-indigo-500 text-white
                  hover:bg-indigo-600 cursor-pointer font-medium"
              >
                Save Personal Settings
              </button>
              {saved && <span className="text-xs text-green-300">Saved!</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
