import { describe, it, expect } from 'vitest';
import { buildAssistantInstructions } from './system-prompt';

describe('buildAssistantInstructions', () => {
  const result = buildAssistantInstructions();

  it('returns a non-empty string', () => {
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('contains identity section', () => {
    expect(result).toContain('Clubhouse Assistant');
    expect(result).toContain('Your tool categories');
    expect(result).toContain('What you cannot do');
    expect(result).toContain('How to interact');
  });

  it('contains tool usage guide', () => {
    expect(result).toContain('Tool Usage Guide');
    expect(result).toContain('Common tool sequences');
    expect(result).toContain('Before destructive operations');
    expect(result).toContain('find_git_repos');
    expect(result).toContain('create_agent');
    expect(result).toContain('layout_canvas');
  });

  it('contains help content from all sections', () => {
    expect(result).toContain('General');
    expect(result).toContain('Projects');
    expect(result).toContain('Getting Started');
  });

  it('contains expanded workflow recipes', () => {
    expect(result).toContain('Workflow Recipes');
    expect(result).toContain('First project onboarding');
    expect(result).toContain('Multi-service debugging');
    expect(result).toContain('Agent instruction writing guide');
    expect(result).toContain('Single to multi-agent migration');
    expect(result).toContain('Quick agent workflows');
    expect(result).toContain('Plugin discovery');
  });

  it('has content in the right order: identity, tools, help, recipes', () => {
    const identityIdx = result.indexOf('Clubhouse Assistant');
    const toolGuideIdx = result.indexOf('Tool Usage Guide');
    const helpIdx = result.indexOf('Clubhouse Help Reference');
    const recipesIdx = result.indexOf('Workflow Recipes');

    expect(identityIdx).toBeLessThan(toolGuideIdx);
    expect(toolGuideIdx).toBeLessThan(helpIdx);
    expect(helpIdx).toBeLessThan(recipesIdx);
  });

  it('stays under 100K characters', () => {
    expect(result.length).toBeLessThan(100_000);
  });

  it('is substantial enough to be useful (> 10K chars)', () => {
    expect(result.length).toBeGreaterThan(10_000);
  });
});
