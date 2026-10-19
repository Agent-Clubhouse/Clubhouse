import { AGENT_SETTINGS_PAGES, useAgentSettingsPages } from '../../features/agents/agentSettingsPages';
import { reportChromeFeature } from '../telemetry';

/**
 * An agent's settings pages in the sidebar (#2015), the same pattern as
 * SettingsNav: one row per page, the selected page renders in the pane. A dot
 * marks a page with unsaved edits. "Shell in worktree" opens the agent's
 * utility shell under the page.
 */

// Same rows as SettingsNav.
const rowClass = (active: boolean) =>
  `w-full h-7 pl-3 pr-2 rounded-md flex items-center gap-2 text-[13px] text-left cursor-pointer ${
    active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
  }`;

export function AgentSettingsNav() {
  const page = useAgentSettingsPages((s) => s.page);
  const dirtyPages = useAgentSettingsPages((s) => s.dirtyPages);
  const counts = useAgentSettingsPages((s) => s.counts);
  const hiddenPages = useAgentSettingsPages((s) => s.hiddenPages);
  const shellOpen = useAgentSettingsPages((s) => s.shellOpen);
  const setPage = useAgentSettingsPages((s) => s.setPage);
  const setShellOpen = useAgentSettingsPages((s) => s.setShellOpen);

  return (
    <nav aria-label="Agent settings" data-testid="agent-settings-nav" className="flex-1 min-h-0 overflow-y-auto pb-2 flex flex-col gap-px px-1.5">
      {AGENT_SETTINGS_PAGES.filter(({ page: p }) => !hiddenPages.includes(p)).map(({ page: p, label }) => {
        const active = page === p;
        const dirty = (dirtyPages as string[]).includes(p);
        const count = counts[p];
        return (
          <button
            key={p}
            type="button"
            aria-current={active ? 'page' : undefined}
            data-testid={`agent-settings-nav-${p}`}
            onClick={() => {
              if (active) return;
              setPage(p);
              reportChromeFeature('agent_settings_page');
            }}
            className={rowClass(active)}
          >
            <span className="truncate">{label}</span>
            {dirty ? (
              <span className="ml-auto w-2 h-2 rounded-full flex-shrink-0 bg-ctp-warning" role="img" aria-label="Unsaved changes" />
            ) : count !== undefined ? (
              <span className="ml-auto text-xs text-ctp-overlay1">{count}</span>
            ) : null}
          </button>
        );
      })}
      <div className="h-px mx-1.5 my-1.5 bg-surface-0 flex-shrink-0" />
      <button
        type="button"
        aria-pressed={shellOpen}
        data-testid="agent-settings-nav-shell"
        onClick={() => {
          setShellOpen(!shellOpen);
          reportChromeFeature('agent_shell_toggle');
        }}
        className={`w-full h-7 pl-3 pr-2 rounded-md flex items-center gap-2 text-[13px] text-left cursor-pointer ${
          shellOpen ? 'bg-surface-0 text-ctp-text' : 'text-ctp-overlay1 hover:bg-surface-0/60 hover:text-ctp-text'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-shrink-0">
          <path d="M4 17l6-6-6-6" /><path d="M12 19h8" />
        </svg>
        <span className="truncate">Shell in worktree</span>
      </button>
    </nav>
  );
}
