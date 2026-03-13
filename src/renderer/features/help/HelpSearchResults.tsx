import type { HelpSearchResult } from './help-search';

interface HelpSearchResultsProps {
  results: HelpSearchResult[];
  activeTopicId: string | null;
  onSelectResult: (sectionId: string, topicId: string) => void;
}

export function HelpSearchResults({ results, activeTopicId, onSelectResult }: HelpSearchResultsProps) {
  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-ctp-subtext0 text-sm px-4">
        <p>No matching topics found.</p>
        <p className="text-xs mt-1">Try a different search term.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 border-b border-surface-0">
        <span className="text-xs text-ctp-subtext0">
          {results.length} {results.length === 1 ? 'result' : 'results'}
        </span>
      </div>
      <nav className="flex-1 py-1 overflow-y-auto">
        {results.map((result) => (
          <button
            key={`${result.sectionId}:${result.topic.id}`}
            onClick={() => onSelectResult(result.sectionId, result.topic.id)}
            className={`w-full px-3 py-2 text-left cursor-pointer transition-colors duration-100 ${
              activeTopicId === result.topic.id
                ? 'bg-surface-1 text-ctp-text'
                : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
            }`}
          >
            <div className="text-sm">{result.topic.title}</div>
            <div className="text-[11px] text-ctp-subtext0 mt-0.5">{result.sectionTitle}</div>
            {result.snippet && (
              <div className="text-[11px] text-ctp-subtext0 mt-1 line-clamp-2 leading-relaxed">
                {result.snippet}
              </div>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
