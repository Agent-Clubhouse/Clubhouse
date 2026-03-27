import identity from './content/identity.md';
import recipes from './content/recipes.md';
import toolGuide from './content/tool-guide.md';
import { HELP_SECTIONS } from '../help/help-content';

/**
 * Build the full CLAUDE.md content for the assistant agent.
 * Concatenates: identity + tool guide + help reference + workflow recipes.
 *
 * Content order matters — identity and tool guide come first so the agent
 * understands its role and capabilities before the reference material.
 */
export function buildAssistantInstructions(): string {
  const helpContent = HELP_SECTIONS
    .map((section) =>
      section.topics
        .map((topic) => `## ${section.title}: ${topic.title}\n\n${topic.content}`)
        .join('\n\n---\n\n'),
    )
    .join('\n\n---\n\n');

  return [
    identity,
    '',
    '---',
    '',
    toolGuide,
    '',
    '---',
    '',
    '# Clubhouse Help Reference',
    '',
    'Use this reference to answer questions about Clubhouse features.',
    '',
    helpContent,
    '',
    '---',
    '',
    recipes,
  ].join('\n');
}
