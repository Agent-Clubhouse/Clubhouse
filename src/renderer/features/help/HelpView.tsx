import { useMemo, useCallback } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { HELP_SECTIONS, HelpSection } from './help-content';
import { getPluginHelpTopics } from './plugin-help';
import { searchHelpTopics } from './help-search';
import { HelpSectionNav } from './HelpSectionNav';
import { HelpTopicList } from './HelpTopicList';
import { HelpContentPane } from './HelpContentPane';
import { HelpSearchInput } from './HelpSearchInput';
import { HelpSearchResults } from './HelpSearchResults';

export function HelpView() {
  const helpSectionId = useUIStore((s) => s.helpSectionId);
  const helpTopicId = useUIStore((s) => s.helpTopicId);
  const helpSearchQuery = useUIStore((s) => s.helpSearchQuery);
  const setHelpSection = useUIStore((s) => s.setHelpSection);
  const setHelpTopic = useUIStore((s) => s.setHelpTopic);
  const setHelpSearchQuery = useUIStore((s) => s.setHelpSearchQuery);

  const projectEnabled = usePluginStore((s) => s.projectEnabled);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const plugins = usePluginStore((s) => s.plugins);

  const pluginSections = useMemo<HelpSection[]>(() => {
    // Collect all plugin IDs enabled at app level or in any project
    const allProjectIds = Object.values(projectEnabled).flat();
    const enabledIds = [...new Set([...appEnabled, ...allProjectIds])];
    return enabledIds
      .map((id) => plugins[id])
      .filter((entry) => entry && entry.status !== 'incompatible')
      .map((entry) => ({
        id: `plugin:${entry.manifest.id}`,
        title: entry.manifest.name,
        topics: getPluginHelpTopics(entry.manifest),
      }));
  }, [projectEnabled, appEnabled, plugins]);

  const allSections = useMemo(
    () => [...HELP_SECTIONS, ...pluginSections],
    [pluginSections],
  );

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

  const activeSection = allSections.find((s) => s.id === helpSectionId) || allSections[0];
  const activeTopic = activeSection?.topics.find((t) => t.id === helpTopicId) || null;

  // When searching and a result is selected, find the topic from search results
  const displayedMarkdown = isSearching && helpTopicId
    ? (searchResults.find((r) => r.topic.id === helpTopicId)?.topic.content ?? activeTopic?.content ?? null)
    : (activeTopic?.content ?? null);

  const setExplorerTab = useUIStore((s) => s.setExplorerTab);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex items-center border-b border-surface-0 bg-ctp-mantle flex-shrink-0">
        <div className="flex-1">
          <HelpSearchInput query={helpSearchQuery} onQueryChange={setHelpSearchQuery} />
        </div>
        <button
          onClick={() => setExplorerTab('assistant')}
          className="flex items-center gap-1.5 px-3 py-2 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 transition-colors cursor-pointer flex-shrink-0"
          title="Ask the assistant"
          data-testid="ask-assistant-button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <circle cx="12" cy="5" r="2" />
            <line x1="12" y1="7" x2="12" y2="11" />
            <line x1="8" y1="16" x2="8" y2="16.01" />
            <line x1="16" y1="16" x2="16" y2="16.01" />
          </svg>
          <span>Ask Assistant</span>
        </button>
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
              sections={HELP_SECTIONS}
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
