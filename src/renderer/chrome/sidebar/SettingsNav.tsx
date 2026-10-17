import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsCategories, isSettingsPageActive, type SettingsCategory } from '../../panels/AccessoryPanel';
import type { SettingsSubPage } from '../../../shared/types';

/**
 * Settings in the sidebar (spec §2, decided 2026-10-16): the app categories,
 * then every project with its own pages, as in today's settings picker. The
 * selected page renders in the pane.
 */

const Chevron = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const rowClass = (active: boolean, indent: string) =>
  `w-full h-7 ${indent} pr-2 rounded-md flex items-center text-[13px] text-left cursor-pointer ${
    active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
  }`;

export function SettingsNav() {
  const settingsContext = useUIStore((s) => s.settingsContext);
  const settingsSubPage = useUIStore((s) => s.settingsSubPage);
  const setSettingsContext = useUIStore((s) => s.setSettingsContext);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  const projects = useProjectStore((s) => s.projects);
  const { app, project } = useSettingsCategories();
  const isApp = settingsContext === 'app';

  const open = (context: 'app' | string, page: SettingsSubPage) => {
    if (settingsContext !== context) setSettingsContext(context);
    setSettingsSubPage(page);
  };

  const pageButton = (context: 'app' | string, { label, page }: SettingsCategory, indent: string) => {
    const active = settingsContext === context && isSettingsPageActive(settingsSubPage, page);
    return (
      <button
        key={`${context}:${page}`}
        type="button"
        aria-current={active ? 'page' : undefined}
        data-testid={`settings-nav-${context === 'app' ? 'app' : 'project'}-${page}`}
        onClick={() => open(context, page)}
        className={rowClass(active, indent)}
      >
        <span className="truncate">{label}</span>
      </button>
    );
  };

  return (
    <nav aria-label="Settings" data-testid="settings-nav" className="flex-1 min-h-0 overflow-y-auto pb-2 flex flex-col gap-px px-1.5">
      <div className="px-1.5 pt-1 pb-1 text-xs font-semibold text-ctp-subtext0">App</div>
      {app.map((c) => pageButton('app', c, 'pl-3'))}

      {projects.length > 0 && (
        <>
          <div className="h-px mx-1.5 my-1.5 bg-surface-0 flex-shrink-0" />
          <div className="px-1.5 pb-1 flex items-center text-xs font-semibold text-ctp-subtext0">
            Projects<span className="ml-auto font-normal text-ctp-overlay1">{projects.length}</span>
          </div>
          {projects.map((p) => {
            const expanded = !isApp && settingsContext === p.id;
            return (
              <div key={p.id} className="flex flex-col gap-px">
                <button
                  type="button"
                  aria-expanded={expanded}
                  data-testid={`settings-nav-project-${p.id}`}
                  onClick={() => (expanded ? open('app', app[0]?.page ?? 'about') : open(p.id, 'project'))}
                  className={rowClass(false, 'pl-1.5')}
                >
                  <span className="text-ctp-overlay1 mr-1.5 flex-shrink-0"><Chevron open={expanded} /></span>
                  <span className="truncate font-medium">{p.displayName || p.name}</span>
                </button>
                {expanded && project.map((c) => pageButton(p.id, c, 'pl-8'))}
              </div>
            );
          })}
        </>
      )}
    </nav>
  );
}
