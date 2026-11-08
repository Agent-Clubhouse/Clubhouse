import { afterEach, describe, expect, it } from 'vitest';
import { _resetConcealedToolsForTesting, clubhouseToolName, isConcealedTool, registerConcealedTools } from './concealed-tools';

afterEach(() => _resetConcealedToolsForTesting());

describe('concealed tool calls (#3036)', () => {
  it('reads every provider\'s name for a Clubhouse tool, and no other server\'s', () => {
    for (const name of ['mcp__clubhouse__start_work', 'clubhouse.start_work', 'clubhouse-start_work', 'clubhouse/start_work', 'start_work']) {
      expect(clubhouseToolName(name), name).toBe('start_work');
    }
    for (const name of ['mcp__github__start_work', 'other.start_work', 'Bash', undefined, '']) {
      expect(clubhouseToolName(name), String(name)).toBe(name === 'Bash' ? 'Bash' : null);
    }
  });

  it('conceals only what a resolver names, for the agents it names', () => {
    expect(isConcealedTool('chat', 'mcp__clubhouse__start_work')).toBe(false);
    const remove = registerConcealedTools((id) => (id === 'chat' ? new Set(['start_work']) : null));
    expect(isConcealedTool('chat', 'mcp__clubhouse__start_work')).toBe(true);
    expect(isConcealedTool('chat', 'mcp__clubhouse__list_agents')).toBe(false);
    expect(isConcealedTool('chat', 'mcp__github__start_work')).toBe(false);
    expect(isConcealedTool('other', 'mcp__clubhouse__start_work')).toBe(false);
    remove();
    expect(isConcealedTool('chat', 'mcp__clubhouse__start_work')).toBe(false);
  });
});
