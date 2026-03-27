import { describe, it, expect } from 'vitest';
import { buildAssistantInstructions } from './system-prompt';

describe('buildAssistantInstructions', () => {
  it('returns a non-empty string', () => {
    const result = buildAssistantInstructions();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('contains identity section', () => {
    const result = buildAssistantInstructions();
    expect(result).toContain('Clubhouse Assistant');
    expect(result).toContain('What you can do');
    expect(result).toContain('What you cannot do');
  });

  it('contains help content from all sections', () => {
    const result = buildAssistantInstructions();
    // Check for key section titles from help content
    expect(result).toContain('General');
    expect(result).toContain('Projects');
    expect(result).toContain('Getting Started');
  });

  it('contains workflow recipes', () => {
    const result = buildAssistantInstructions();
    expect(result).toContain('Workflow Recipes');
    expect(result).toContain('First project onboarding');
    expect(result).toContain('Multi-service debugging');
  });

  it('has reasonable length (not too small, not too huge)', () => {
    const result = buildAssistantInstructions();
    // Should be substantial (all help content + identity + recipes)
    expect(result.length).toBeGreaterThan(5000);
    // But not unreasonably large
    expect(result.length).toBeLessThan(200000);
  });
});
