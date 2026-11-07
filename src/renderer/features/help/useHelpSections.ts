import { useEffect, useMemo, useState } from 'react';
import { usePluginStore } from '../../plugins/plugin-store';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { getHelpSections, HelpSection, HelpTopic } from './help-content';
import { getPluginHelpTopics } from './plugin-help';

export interface HelpSections {
  /** The active shell's built-in sections. */
  builtIn: HelpSection[];
  /** One section per enabled plugin, app-wide or in any project. */
  plugins: HelpSection[];
  /** Both, built-in first: what search covers. */
  all: HelpSection[];
}

/** Every help section for the active shell, plugin sections included. */
export function useHelpSections(): HelpSections {
  const newChrome = useChromeFlagStore((s) => s.enabled);
  const projectEnabled = usePluginStore((s) => s.projectEnabled);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const plugins = usePluginStore((s) => s.plugins);

  // The new shell lists Annex wherever Settings shows the Annex pages (preview-eligible builds).
  const [annex, setAnnex] = useState(false);
  useEffect(() => {
    if (!newChrome) return;
    let live = true;
    window.clubhouse.app.isPreviewEligible?.()
      .then((eligible) => { if (live) setAnnex(eligible); })
      .catch(() => { /* telemetry-exempt: without the answer, Help just leaves Annex out */ });
    return () => { live = false; };
  }, [newChrome]);

  const pluginSections = useMemo<HelpSection[]>(() => {
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

  // getHelpSections reads the shell flag itself; newChrome is listed so the memo follows it.
  const builtIn = useMemo(() => getHelpSections({ annex }), [annex, newChrome]);
  const all = useMemo(() => [...builtIn, ...pluginSections], [builtIn, pluginSections]);
  return { builtIn, plugins: pluginSections, all };
}

/**
 * The section and topic Help shows. With no topic picked yet, the new shell
 * opens the section's first topic, so the pane is never empty.
 */
export function resolveHelpSelection(
  sections: HelpSection[],
  sectionId: string,
  topicId: string | null,
  fallbackToFirst: boolean,
): { section: HelpSection | undefined; topic: HelpTopic | null } {
  const section = sections.find((s) => s.id === sectionId) || sections[0];
  const topic = section?.topics.find((t) => t.id === topicId)
    ?? (fallbackToFirst ? section?.topics[0] ?? null : null);
  return { section, topic };
}
