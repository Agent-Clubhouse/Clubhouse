import { describe, it, expect } from 'vitest';
import { generateDurableName, generateQuickName, generateHubName, AGENT_COLORS } from './name-generator';

describe('generateDurableName', () => {
  it('returns adjective-animal format', () => {
    const name = generateDurableName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('always produces non-empty, hyphenated, lowercase strings (100 iterations)', () => {
    for (let i = 0; i < 100; i++) {
      const name = generateDurableName();
      expect(name.length).toBeGreaterThan(0);
      expect(name).toContain('-');
      expect(name).toBe(name.toLowerCase());
      const parts = name.split('-');
      expect(parts.length).toBe(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    }
  });
});

describe('generateQuickName', () => {
  it('returns adjective-noun format', () => {
    const name = generateQuickName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('always produces non-empty, hyphenated, lowercase strings (100 iterations)', () => {
    for (let i = 0; i < 100; i++) {
      const name = generateQuickName();
      expect(name.length).toBeGreaterThan(0);
      expect(name).toContain('-');
      expect(name).toBe(name.toLowerCase());
      const parts = name.split('-');
      expect(parts.length).toBe(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    }
  });
});

describe('generateHubName', () => {
  it('returns adjective-place format', () => {
    const name = generateHubName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('always produces non-empty, hyphenated, lowercase strings (100 iterations)', () => {
    for (let i = 0; i < 100; i++) {
      const name = generateHubName();
      expect(name.length).toBeGreaterThan(0);
      expect(name).toContain('-');
      expect(name).toBe(name.toLowerCase());
      const parts = name.split('-');
      expect(parts.length).toBe(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    }
  });
});

describe('AGENT_COLORS', () => {
  it('has 8 entries', () => {
    expect(AGENT_COLORS).toHaveLength(8);
  });

  it('all entries have required fields', () => {
    for (const color of AGENT_COLORS) {
      expect(color).toHaveProperty('id');
      expect(color).toHaveProperty('label');
      expect(color).toHaveProperty('bg');
      expect(color).toHaveProperty('ring');
      expect(color).toHaveProperty('hex');
      expect(typeof color.id).toBe('string');
      expect(typeof color.label).toBe('string');
      expect(typeof color.bg).toBe('string');
      expect(typeof color.ring).toBe('string');
      expect(typeof color.hex).toBe('string');
    }
  });

  it('hex values are valid #rrggbb', () => {
    for (const color of AGENT_COLORS) {
      expect(color.hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('all color IDs are unique', () => {
    const ids = AGENT_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
