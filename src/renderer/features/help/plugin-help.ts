import type { PluginManifest } from '../../../shared/plugin-types';
import type { HelpTopic } from './help-content';

export function getPluginHelpTopics(manifest: PluginManifest): HelpTopic[] {
  const topics: HelpTopic[] = [];

  // Auto-generated "About" topic
  const rows = [
    `| **Name** | ${manifest.name} |`,
    `| **Version** | ${manifest.version} |`,
    manifest.author ? `| **Author** | ${manifest.author} |` : null,
    `| **API Version** | ${manifest.engine.api} |`,
    `| **Scope** | ${manifest.scope} |`,
  ].filter(Boolean);

  const aboutContent = [
    `# ${manifest.name}`,
    '',
    manifest.description || '_No description provided._',
    '',
    '| | |',
    '|---|---|',
    ...rows,
  ].join('\n');

  topics.push({ id: `${manifest.id}-about`, title: 'About', content: aboutContent });

  // Custom topics from contributes.help.topics
  if (manifest.contributes?.help?.topics) {
    for (const topic of manifest.contributes.help.topics) {
      topics.push({
        id: `${manifest.id}-${topic.id}`,
        title: topic.title,
        content: topic.content,
      });
    }
  }

  return topics;
}
