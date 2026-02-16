import { useMemo } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { HELP_SECTIONS, HelpSection } from './help-content';
import { getPluginHelpTopics } from './plugin-help';
import { HelpSectionNav } from './HelpSectionNav';
import { HelpTopicList } from './HelpTopicList';
import { HelpContentPane } from './HelpContentPane';

export function HelpView() {
  const helpSectionId = useUIStore((s) => s.helpSectionId);
  const helpTopicId = useUIStore((s) => s.helpTopicId);
  const setHelpSection = useUIStore((s) => s.setHelpSection);
  const setHelpTopic = useUIStore((s) => s.setHelpTopic);

  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectEnabled = usePluginStore((s) => s.projectEnabled);
  const plugins = usePluginStore((s) => s.plugins);

  const pluginSections = useMemo<HelpSection[]>(() => {
    if (!activeProjectId) return [];
    const enabledIds = projectEnabled[activeProjectId] || [];
    return enabledIds
      .map((id) => plugins[id])
      .filter((entry) => entry && entry.status !== 'incompatible')
      .map((entry) => ({
        id: `plugin:${entry.manifest.id}`,
        title: entry.manifest.name,
        topics: getPluginHelpTopics(entry.manifest),
      }));
  }, [activeProjectId, projectEnabled, plugins]);

  const allSections = useMemo(
    () => [...HELP_SECTIONS, ...pluginSections],
    [pluginSections],
  );

  const activeSection = allSections.find((s) => s.id === helpSectionId) || allSections[0];
  const activeTopic = activeSection?.topics.find((t) => t.id === helpTopicId) || null;

  return (
    <div className="h-full min-h-0 grid grid-cols-[200px_240px_1fr]">
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
      <HelpContentPane markdown={activeTopic?.content || null} />
    </div>
  );
}
