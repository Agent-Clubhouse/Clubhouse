import { useLinkSuggestions } from './projectLinks';
import { useNetworkSidebarStore } from './networkSidebarStore';

/**
 * A quiet line in the sidebar suggesting a link (#3066): a project here and
 * the same project on another machine, by their shared git remote. One at a
 * time; Link groups them in the sidebar, Keep separate never asks again.
 */
export function LinkSuggestionLine() {
  const suggestions = useLinkSuggestions();
  const link = useNetworkSidebarStore((s) => s.link);
  const keepSeparate = useNetworkSidebarStore((s) => s.keepSeparate);
  const first = suggestions[0];
  if (!first) return null;
  const name = first.local.displayName || first.local.name;
  const machine = first.remote.satelliteName || 'another computer';
  return (
    <div data-testid="link-suggestion" className="flex-shrink-0 mx-2 mb-1 px-2 py-1.5 text-xs text-ctp-subtext0 border-t border-surface-0">
      <span>{name} is also on {machine}, with the same git remote.</span>
      <span className="flex gap-3 pt-1">
        <button
          type="button"
          className="text-ctp-accent hover:underline cursor-pointer"
          onClick={() => link(first.local.id, first.remote.id)}
        >
          Link
        </button>
        <button type="button" className="text-ctp-overlay1 hover:text-ctp-text cursor-pointer" onClick={() => keepSeparate(first.local.id, first.remote.id)}>
          Keep separate
        </button>
      </span>
    </div>
  );
}
