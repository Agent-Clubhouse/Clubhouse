import type { Project } from '../../shared/types';

/**
 * Which project a New agent form starts on, and why (#2031, #2812): one asked
 * for, the only one, the project in view, then the last one used. `inView` is
 * true when the person is looking at that project, so a form can treat it as
 * the current project rather than ask.
 */
export function startingProject(
  projects: readonly Pick<Project, 'id'>[],
  { requested, activeProjectId, explorerTab, lastProjectId, dispatcherOpen = false }: { requested?: string; activeProjectId: string | null; explorerTab: string; lastProjectId: string | null; dispatcherOpen?: boolean },
): { id: string; why: string; inView: boolean } {
  const has = (id: string | null | undefined): id is string => !!id && projects.some((p) => p.id === id);
  if (has(requested)) return { id: requested, why: '', inView: true };
  if (projects.length === 1) return { id: projects[0].id, why: '', inView: true };
  // On Canvas, Review, Settings or Help no project is highlighted in the sidebar, and the Dispatcher's view covers the project's.
  const projectInView = !dispatcherOpen && explorerTab !== 'settings' && explorerTab !== 'help' && !explorerTab.startsWith('plugin:app:');
  if (projectInView && has(activeProjectId)) return { id: activeProjectId, why: 'selected in the sidebar', inView: true };
  if (has(lastProjectId)) return { id: lastProjectId, why: 'the last project you used', inView: false };
  if (has(activeProjectId)) return { id: activeProjectId, why: 'the last project you used', inView: false };
  return { id: projects[0]?.id ?? '', why: '', inView: false };
}
