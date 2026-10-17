import { useMemo, useCallback } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { searchHelpTopics } from './help-search';
import { useHelpSections, resolveHelpSelection } from './useHelpSections';
import { HelpSectionNav } from './HelpSectionNav';
import { HelpTopicList } from './HelpTopicList';
import { HelpContentPane } from './HelpContentPane';
import { HelpSearchInput } from './HelpSearchInput';
import { HelpSearchResults } from './HelpSearchResults';

/**
 * Help in the pane. The new shell lists topics and search results in the
 * sidebar (chrome/sidebar/HelpNav.tsx), so the pane is only the article.
 */
export function HelpView() {
  const newChrome = useChromeFlagStore((s) => s.enabled);
  return newChrome ? <ChromeHelpArticle /> : <ClassicHelpView />;
}

function ChromeHelpArticle() {
  const helpSectionId = useUIStore((s) => s.helpSectionId);
  const helpTopicId = useUIStore((s) => s.helpTopicId);
  const { all } = useHelpSections();
  const { topic } = resolveHelpSelection(all, helpSectionId, helpTopicId, true);
  return <HelpContentPane markdown={topic?.content ?? null} variant="chrome" />;
}

function ClassicHelpView() {
  const helpSectionId = useUIStore((s) => s.helpSectionId);
  const helpTopicId = useUIStore((s) => s.helpTopicId);
  const helpSearchQuery = useUIStore((s) => s.helpSearchQuery);
  const setHelpSection = useUIStore((s) => s.setHelpSection);
  const setHelpTopic = useUIStore((s) => s.setHelpTopic);
  const setHelpSearchQuery = useUIStore((s) => s.setHelpSearchQuery);

  const { builtIn, plugins: pluginSections, all: allSections } = useHelpSections();

  const isSearching = helpSearchQuery.trim().length > 0;

  const searchResults = useMemo(
    () => isSearching ? searchHelpTopics(allSections, helpSearchQuery) : [],
    [allSections, helpSearchQuery, isSearching],
  );

  const handleSelectResult = useCallback(
    (sectionId: string, topicId: string) => {
      setHelpSection(sectionId);
      // setHelpSection clears topicId, so set it after
      setHelpTopic(topicId);
    },
    [setHelpSection, setHelpTopic],
  );

  const { section: activeSection, topic: activeTopic } = resolveHelpSelection(allSections, helpSectionId, helpTopicId, false);

  // When searching and a result is selected, find the topic from search results
  const displayedMarkdown = isSearching && helpTopicId
    ? (searchResults.find((r) => r.topic.id === helpTopicId)?.topic.content ?? activeTopic?.content ?? null)
    : (activeTopic?.content ?? null);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex items-center border-b border-surface-0 bg-ctp-mantle flex-shrink-0">
        <div className="flex-1">
          <HelpSearchInput query={helpSearchQuery} onQueryChange={setHelpSearchQuery} />
        </div>
      </div>
      <div className={`flex-1 min-h-0 grid ${isSearching ? 'grid-cols-[300px_1fr]' : 'grid-cols-[200px_240px_1fr]'}`}>
        {isSearching ? (
          <div className="bg-ctp-base border-r border-surface-0 h-full overflow-hidden">
            <HelpSearchResults
              results={searchResults}
              activeTopicId={helpTopicId}
              onSelectResult={handleSelectResult}
            />
          </div>
        ) : (
          <>
            <HelpSectionNav
              sections={builtIn}
              pluginSections={pluginSections}
              activeSectionId={helpSectionId}
              onSelectSection={setHelpSection}
            />
            <HelpTopicList
              sectionTitle={activeSection?.title || ''}
              topics={activeSection?.topics || []}
              activeTopicId={helpTopicId}
              onSelectTopic={setHelpTopic}
            />
          </>
        )}
        <HelpContentPane markdown={displayedMarkdown} />
      </div>
    </div>
  );
}
