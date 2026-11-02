import { describe, expect, it } from 'vitest';
import { agentAvatarSpec, agentInitials, initialsTextColor } from './agent-avatar';
import { AGENT_COLORS } from './name-generator';

describe('agentInitials', () => {
  it.each([
    ['Dispatcher', 'D'],
    ['clever-fox', 'CF'],
    ['Clubhouse-Orchestrator', 'CO'],
    ['one-two-three', 'OT'],
    ['my_agent', 'M'],
    ['Two Words', 'T'],
    ['double--dash', 'DD'],
    ['7-up', '7U'],
    ['🦊-fox', '🦊F'],
    ['🦊🐻-🐼🐨', '🦊🐼'],
    ['a-🦊-fox', 'A🦊'],
    ['', ''],
  ])('%s is %s', (name, initials) => {
    expect(agentInitials(name)).toBe(initials);
  });
});

describe('initialsTextColor', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it.each([
    ['#000000', '#ffffff'],
    ['#ffffff', '#000000'],
    ['#1e1e2e', '#ffffff'],
    ['#ffff00', '#000000'],
    // Either side of where the two ratios cross, luminance about 0.179.
    ['#757575', '#ffffff'],
    ['#777777', '#000000'],
  ])('on %s is %s', (background, text) => {
    expect(initialsTextColor(background)).toBe(text);
  });

  it.each(AGENT_COLORS.map(({ id, hex }) => [id, hex]))('%s gets the color with more contrast, at AA for normal text', (_id, hex) => {
    const text = initialsTextColor(hex);
    const other = text === '#ffffff' ? '#000000' : '#ffffff';
    expect(ratio(text, hex)).toBeGreaterThan(ratio(other, hex));
    expect(ratio(text, hex)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('agentAvatarSpec', () => {
  it('draws a quick agent as the bolt, whatever else it has', () => {
    expect(agentAvatarSpec({ name: 'swift-fox', kind: 'quick', color: 'gray', emoji: '🦊' })).toEqual({ type: 'quick' });
  });

  it('puts the emoji ahead of the image', () => {
    expect(agentAvatarSpec({ name: 'a', color: 'rose', emoji: '🦊', icon: 'a.png' }, 'data:x'))
      .toEqual({ type: 'emoji', emoji: '🦊', background: '#f43f5e20' });
  });

  it('draws the image only with its data', () => {
    expect(agentAvatarSpec({ name: 'a', icon: 'a.png' }, 'data:x')).toEqual({ type: 'image', image: 'data:x' });
    expect(agentAvatarSpec({ name: 'a', icon: 'a.png' })).toMatchObject({ type: 'initials', initials: 'A' });
    expect(agentAvatarSpec({ name: 'a' }, 'data:x')).toMatchObject({ type: 'initials' });
  });

  it('falls back to indigo for a missing or unknown color', () => {
    expect(agentAvatarSpec({ name: 'gone-helper' })).toEqual({ type: 'initials', initials: 'GH', background: '#6366f1' });
    expect(agentAvatarSpec({ name: 'gone', color: 'plaid' })).toMatchObject({ background: '#6366f1' });
  });
});
