import React, { useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { usePluginStore } from '../plugins/plugin-store';
import type { PluginRegistryEntry } from '../../shared/plugin-types';
import type { Project } from '../../shared/types';
import { getAgentColorHex } from '../../shared/name-generator';
import { sanitizeSvg } from '../utils/sanitize-svg';
import { AgentList } from '../features/agents/AgentList';
import { reportChromeFeature, reportChromeActionFailed } from './telemetry';

/**
 * Sidebar for the new chrome, Phase 1a (docs/chrome-redesign-spec.md §7).
 *
 * This first cut keeps behavior identical to the legacy shell while the shell
 * itself lands: an app row for app-level plugin views, a compact project list,
 * the active project's existing agent list, and a footer. Phase 1b replaces the
 * project list and agent list with the project tree and 30px rows.
 *
 * Test IDs are the legacy ones where the element means the same thing (§9):
 * `project-<id>`, `nav-add-project`, `nav-help`, `nav-settings`.
 */

const PLUGIN_FALLBACK_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

const rowClass = (active: boolean) =>
  `w-full h-7 px-2 rounded-md flex items-center gap-2 text-[13px] text-left cursor-pointer transition-colors duration-100 ${
    active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
  }`;

const ProjectSquare = React.memo(function ProjectSquare({ project, iconUrl }: { project: Project; iconUrl?: string }) {
  const label = project.displayName || project.name;
  const hex = getAgentColorHex(project.color);
  if (project.emoji) {
    return <span className="w-[18px] h-[18px] rounded flex-shrink-0 flex items-center justify-center text-[12px]" style={{ backgroundColor: `${hex}26` }} aria-hidden="true">{project.emoji}</span>;
  }
  if (project.icon && iconUrl) {
    return <img src={iconUrl} alt="" draggable={false} className="w-[18px] h-[18px] rounded flex-shrink-0 object-cover" />;
  }
  return (
    <span className="w-[18px] h-[18px] rounded flex-shrink-0 flex items-center justify-center text-xs font-bold" style={{ backgroundColor: `${hex}33`, color: hex }} aria-hidden="true">
      {label.charAt(0).toUpperCase()}
    </span>
  );
});

function AppItemButton({ entry, active, onOpen }: { entry: PluginRegistryEntry; active: boolean; onOpen: (id: string) => void }) {
  const rail = entry.manifest.contributes!.railItem!;
  return (
    <button
      type="button"
      title={rail.title || rail.label}
      onClick={() => onOpen(entry.manifest.id)}
      data-active={active}
      className={`${rowClass(active)} [&_svg]:w-[15px] [&_svg]:h-[15px]`}
    >
      <span className="flex-shrink-0 flex items-center text-ctp-subtext0">
        {rail.icon ? <span dangerouslySetInnerHTML={{ __html: sanitizeSvg(rail.icon) }} /> : PLUGIN_FALLBACK_ICON}
      </span>
      <span className="truncate">{rail.label}</span>
    </button>
  );
}

export function ChromeSidebar() {
  const projects = useProjectStore((s) => s.projects);
  const projectIcons = useProjectStore((s) => s.projectIcons);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const pickAndAddProject = useProjectStore((s) => s.pickAndAddProject);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const toggleHelp = useUIStore((s) => s.toggleHelp);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const plugins = usePluginStore((s) => s.plugins);
  const appEnabled = usePluginStore((s) => s.appEnabled);

  // Same visibility rule as the legacy rail: app-enabled, app or dual scope,
  // not incompatible, and contributes a rail item.
  const { topItems, bottomItems } = useMemo(() => {
    const items = appEnabled
      .map((id) => plugins[id])
      .filter((entry): entry is PluginRegistryEntry => {
        if (!entry) return false;
        if (entry.manifest.scope !== 'app' && entry.manifest.scope !== 'dual') return false;
        if (entry.status === 'incompatible') return false;
        return !!entry.manifest.contributes?.railItem;
      });
    return {
      topItems: items.filter((e) => (e.manifest.contributes!.railItem!.position ?? 'top') === 'top'),
      bottomItems: items.filter((e) => e.manifest.contributes!.railItem!.position === 'bottom'),
    };
  }, [appEnabled, plugins]);

  const inProjectView = explorerTab !== 'settings' && explorerTab !== 'help' && !explorerTab.startsWith('plugin:app:');

  const openAppItem = (id: string) => {
    setExplorerTab(`plugin:app:${id}`);
    reportChromeFeature('app_item_open');
  };

  const selectProject = (id: string) => {
    setActiveProject(id);
    // Leaving an app-level view for a project returns to that project's tabs.
    if (!inProjectView && explorerTab !== 'settings') {
      useUIStore.getState().restoreProjectView(id);
    }
    reportChromeFeature('project_select');
  };

  const addProject = () => {
    pickAndAddProject().catch((err) => reportChromeActionFailed('add_project', err));
  };

  return (
    <aside
      data-testid="chrome-sidebar"
      aria-label="Sidebar"
      className="h-full min-h-0 flex flex-col bg-ctp-mantle border-r border-surface-0 overflow-hidden"
    >
      {topItems.length > 0 && (
        <nav aria-label="App views" className="flex-shrink-0 px-1.5 pt-2 pb-1 flex flex-col gap-px">
          {topItems.map((entry) => (
            <AppItemButton
              key={entry.manifest.id}
              entry={entry}
              active={explorerTab === `plugin:app:${entry.manifest.id}`}
              onOpen={openAppItem}
            />
          ))}
        </nav>
      )}

      <div className="flex-shrink-0 flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-xs font-semibold text-ctp-subtext0">Projects</span>
        <button
          type="button"
          onClick={addProject}
          title="Add project"
          aria-label="Add project"
          data-testid="nav-add-project"
          className="w-6 h-6 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      <nav aria-label="Projects" className="flex-shrink-0 max-h-[40%] overflow-y-auto px-1.5 pb-1 flex flex-col gap-px">
        {projects.map((p) => {
          const active = p.id === activeProjectId && inProjectView;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => selectProject(p.id)}
              data-testid={`project-${p.id}`}
              data-active={p.id === activeProjectId}
              title={p.displayName || p.name}
              className={rowClass(active)}
            >
              <ProjectSquare project={p} iconUrl={projectIcons[p.id]} />
              <span className="truncate font-medium">{p.displayName || p.name}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-h-0 border-t border-surface-0 overflow-hidden">
        {activeProjectId && inProjectView ? <AgentList /> : null}
      </div>

      <div className="flex-shrink-0 h-10 border-t border-surface-0 flex items-center gap-1 px-2">
        {bottomItems.map((entry) => {
          const rail = entry.manifest.contributes!.railItem!;
          return (
            <button
              key={entry.manifest.id}
              type="button"
              title={rail.title || rail.label}
              aria-label={rail.label}
              onClick={() => openAppItem(entry.manifest.id)}
              className="w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer [&_svg]:w-[15px] [&_svg]:h-[15px]"
            >
              {rail.icon ? <span dangerouslySetInnerHTML={{ __html: sanitizeSvg(rail.icon) }} /> : PLUGIN_FALLBACK_ICON}
            </button>
          );
        })}
        <span className="flex-1" />
        <button
          type="button"
          onClick={toggleHelp}
          title="Help"
          aria-label="Help"
          data-testid="nav-help"
          data-active={explorerTab === 'help'}
          className="w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />
          </svg>
        </button>
        <button
          type="button"
          onClick={toggleSettings}
          title="Settings"
          aria-label="Settings"
          data-testid="nav-settings"
          data-active={explorerTab === 'settings'}
          className="w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
