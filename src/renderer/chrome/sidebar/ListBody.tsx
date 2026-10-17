import { AccessoryPanel } from '../../panels/AccessoryPanel';
import { useChromeScope } from '../scope';

/**
 * A project tab's own list in the sidebar (spec §4.6): Files' tree, Git's
 * changes, Issues, Automations, Browser history. Scoped tabs get a line saying
 * what they point at. The plugin's SidebarPanel renders through AccessoryPanel,
 * which keeps today's Annex gating for remote projects.
 */
const SCOPED_TABS = new Set(['plugin:files', 'plugin:git']);

export function ListBody({ explorerTab, projectId }: { explorerTab: string; projectId: string | null }) {
  const scope = useChromeScope(projectId);
  const showScope = SCOPED_TABS.has(explorerTab) && scope;
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="sidebar-list">
      {showScope && (
        <div
          data-testid="scope-line"
          className="flex-shrink-0 mx-2 mb-1.5 h-7 flex items-center gap-1.5 px-2 rounded-md border border-surface-0 text-xs"
          title={scope.cwd}
        >
          <span className="font-semibold text-ctp-text truncate">{scope.label}</span>
          <span className="text-ctp-overlay1 flex-shrink-0">{scope.kind === 'project' ? 'root' : scope.isWorktree ? 'worktree' : 'no worktree, using root'}</span>
        </div>
      )}
      <div className="flex-1 min-h-0 border-t border-surface-0">
        <AccessoryPanel bare />
      </div>
    </div>
  );
}
