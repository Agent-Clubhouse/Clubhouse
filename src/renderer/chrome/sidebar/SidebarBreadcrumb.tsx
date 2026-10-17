/**
 * "Agents / <view>" at the top of the sidebar when a list or Settings replaces
 * the agent tree (spec §4.6). Agents goes back to the tree.
 */
export function SidebarBreadcrumb({ current, onBack }: { current: string; onBack: () => void }) {
  return (
    <div data-testid="list-breadcrumb" className="flex-shrink-0 flex items-center gap-1.5 px-3 pt-1 pb-2 text-xs">
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-ctp-accent hover:underline cursor-pointer">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        Agents
      </button>
      <span className="text-ctp-overlay0" aria-hidden="true">/</span>
      <span className="font-semibold text-ctp-text truncate">{current}</span>
    </div>
  );
}
