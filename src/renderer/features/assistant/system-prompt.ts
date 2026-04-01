import identity from './content/identity.md';
import recipes from './content/recipes.md';
import toolGuide from './content/tool-guide.md';
import { HELP_SECTIONS } from '../help/help-content';

/**
 * Build the full CLAUDE.md content for the assistant agent.
 * Concatenates: identity + tool guide + help topic index + workflow recipes.
 *
 * Content order matters — identity and tool guide come first so the agent
 * understands its role and capabilities before the reference material.
 *
 * Help content is NOT inlined — the assistant uses `search_help` to retrieve
 * specific topics on demand, keeping the prompt compact (~10-12KB).
 */
export function buildAssistantInstructions(): string {
  const topicIndex = HELP_SECTIONS
    .map((section) => {
      const topics = section.topics.map((t) => t.title).join(', ');
      return `- **${section.title}**: ${topics}`;
    })
    .join('\n');

  return [
    identity,
    '',
    '---',
    '',
    toolGuide,
    '',
    '---',
    '',
    '# Available Help Topics',
    '',
    'Use `search_help` to retrieve detailed content on any of these topics.',
    '',
    topicIndex,
    '',
    '---',
    '',
    recipes,
  ].join('\n').replace(/\r\n/g, '\n');  // Normalize CRLF for consistent size across platforms
}
