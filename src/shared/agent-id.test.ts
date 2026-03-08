import { describe, it, expect } from 'vitest';
import { generateQuickAgentId } from './agent-id';

describe('generateQuickAgentId', () => {
  it('returns a string starting with quick_', () => {
    const id = generateQuickAgentId();
    expect(id).toMatch(/^quick_/);
  });

  it('has three underscore-separated parts', () => {
    const id = generateQuickAgentId();
    const parts = id.split('_');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('quick');
  });

  it('includes a numeric timestamp in the second segment', () => {
    const before = Date.now();
    const id = generateQuickAgentId();
    const after = Date.now();
    const ts = Number(id.split('_')[1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('includes an 8-character hex/alphanumeric suffix', () => {
    const id = generateQuickAgentId();
    const suffix = id.split('_')[2];
    expect(suffix).toHaveLength(8);
    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  it('generates unique IDs across 200 rapid calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      ids.add(generateQuickAgentId());
    }
    expect(ids.size).toBe(200);
  });
});
