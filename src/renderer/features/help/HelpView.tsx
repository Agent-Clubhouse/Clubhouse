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

  return (
    <div className="h-full min-h-0 flex flex-col">
      <HelpSearchInput query={helpSearchQuery} onQueryChange={setHelpSearchQuery} />
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
