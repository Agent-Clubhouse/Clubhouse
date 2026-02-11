import { useEffect, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { ProjectSettings as ProjectSettingsType } from '../../../shared/types';

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
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Project Defaults</h2>

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
