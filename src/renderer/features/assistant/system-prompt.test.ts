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

  it('contains help topic index (not full content)', () => {
    expect(result).toContain('Available Help Topics');
    expect(result).toContain('search_help');
    expect(result).toContain('General');
    expect(result).toContain('Projects');
    expect(result).toContain('Agents & Orchestrators');
    expect(result).toContain('Plugins');
    expect(result).toContain('Settings');
    expect(result).toContain('Troubleshooting');
    expect(result).toContain('Agent Personas');
  });

  it('does not contain full help content dump', () => {
    // The prompt should NOT contain the full help article bodies —
    // those are retrieved on demand via search_help
    expect(result).not.toContain('Clubhouse Help Reference');
  });

  it('contains workflow recipes', () => {
    expect(result).toContain('Workflow Recipes');
    expect(result).toContain('First project onboarding');
    expect(result).toContain('Canvas-based team coordination');
    expect(result).toContain('Agent instruction writing guide');
    expect(result).toContain('Monorepo setup');
    expect(result).toContain('Multi-agent debugging');
  });

  it('has content in the right order: identity, tools, help index, recipes', () => {
    const identityIdx = result.indexOf('Clubhouse Assistant');
    const toolGuideIdx = result.indexOf('Tool Usage Guide');
    const helpIdx = result.indexOf('Available Help Topics');
    const recipesIdx = result.indexOf('Workflow Recipes');

    expect(identityIdx).toBeLessThan(toolGuideIdx);
    expect(toolGuideIdx).toBeLessThan(helpIdx);
    expect(helpIdx).toBeLessThan(recipesIdx);
  });

  it('stays under 15KB (target 10-12KB without full help dump)', () => {
    expect(result.length).toBeLessThan(15_000);
  });

  it('is substantial enough to be useful (> 5K chars)', () => {
    expect(result.length).toBeGreaterThan(5_000);
  });
});
