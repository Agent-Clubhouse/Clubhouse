import identity from './content/identity.md';
import recipes from './content/recipes.md';
import { HELP_SECTIONS } from '../help/help-content';

/**
 * Build the full CLAUDE.md content for the assistant agent.
 * Concatenates: identity + all help content + workflow recipes.
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
