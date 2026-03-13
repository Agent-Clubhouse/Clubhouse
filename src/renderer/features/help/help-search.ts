import type { HelpSection, HelpTopic } from './help-content';

export interface HelpSearchResult {
  topic: HelpTopic;
  sectionId: string;
  sectionTitle: string;
  /** Relevance score — higher is better */
  score: number;
  /** Plain-text snippet around the first content match (null if title-only match) */
  snippet: string | null;
}

/**
 * Strip markdown formatting to get searchable plain text.
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')     // headings
    .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
    .replace(/\*(.+?)\*/g, '$1')      // italic
    .replace(/`(.+?)`/g, '$1')        // inline code
    .replace(/```[\s\S]*?```/g, '')   // code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/[|_\-~>]/g, ' ')        // table/horizontal rule chars
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a snippet of ~80 chars around the first occurrence of `query` in `text`.
 */
function extractSnippet(text: string, query: string): string | null {
  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const idx = lower.indexOf(queryLower);
  if (idx === -1) return null;

  const snippetRadius = 40;
  const start = Math.max(0, idx - snippetRadius);
  const end = Math.min(text.length, idx + query.length + snippetRadius);
  let snippet = text.slice(start, end).trim();

  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';

  return snippet;
}

/**
 * Search help topics across all sections by matching against title and content.
 *
 * Scoring:
 *   - Title substring match: 100 + bonus for prefix
 *   - Title word-starts match (e.g. "kb" matches "Keyboard"): 60
 *   - Content substring match: 40
 *
 * Results are sorted by score descending.
 */
export function searchHelpTopics(
  sections: HelpSection[],
  query: string,
): HelpSearchResult[] {
  if (!query || query.trim().length === 0) return [];

  const q = query.trim().toLowerCase();
  const results: HelpSearchResult[] = [];

  for (const section of sections) {
    for (const topic of section.topics) {
      const titleLower = topic.title.toLowerCase();
      const plainContent = stripMarkdown(topic.content);
      const contentLower = plainContent.toLowerCase();

      let score = 0;
      let snippet: string | null = null;

      // Title scoring
      const titleIdx = titleLower.indexOf(q);
      if (titleIdx !== -1) {
        score = 100;
        if (titleIdx === 0) score += 20; // prefix bonus
        // Coverage bonus — query covers more of the title = higher score
        score += Math.round((q.length / titleLower.length) * 30);
      } else {
        // Word-start matching: check if query chars match starts of words
        const words = titleLower.split(/\s+/);
        let qi = 0;
        for (const word of words) {
          if (qi < q.length && word.startsWith(q[qi])) {
            qi++;
          }
        }
        if (qi === q.length && q.length > 1) {
          score = 60;
        }
      }

      // Content scoring
      if (contentLower.includes(q)) {
        if (score === 0) score = 40; // content-only match
        else score += 10; // bonus if both title and content match
        snippet = extractSnippet(plainContent, query.trim());
      }

      if (score > 0) {
        results.push({
          topic,
          sectionId: section.id,
          sectionTitle: section.title,
          score,
          snippet,
        });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
