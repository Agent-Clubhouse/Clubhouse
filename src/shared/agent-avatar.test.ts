import { describe, expect, it } from 'vitest';
import { agentAvatarSpec, agentInitials } from './agent-avatar';

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
    ['', ''],
  ])('%s is %s', (name, initials) => {
    expect(agentInitials(name)).toBe(initials);
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
