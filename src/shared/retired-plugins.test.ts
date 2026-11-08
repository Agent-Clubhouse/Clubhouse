import { describe, it, expect } from 'vitest';
import { RETIRED_PLUGINS, isRetiredPlugin, retiredPluginMessage } from './retired-plugins';
import { validateManifest } from './manifest-validator';

describe('retired Workshop plugins (#2756)', () => {
  it('retires exactly Lounge, KanBoss and Bug Report, by their Workshop ids', () => {
    expect(Object.keys(RETIRED_PLUGINS).sort()).toEqual(['bug-report', 'kanboss', 'lounge']);
    expect(isRetiredPlugin('lounge')).toBe(true);
    expect(isRetiredPlugin('pomodoro')).toBe(false);
    expect(isRetiredPlugin('constructor')).toBe(false);
  });

  it('says the plugin was retired, that its data is kept, and what replaces Lounge', () => {
    const message = retiredPluginMessage('lounge');
    expect(message).toContain('Lounge was retired');
    expect(message).toContain('data is kept');
    expect(message).toContain('sidebar project tree and Needs you');
    expect(message).toContain('Custom circles');
    expect(retiredPluginMessage('pomodoro')).toBe('');
  });

  it('refuses a retired plugin\'s manifest with that one message, even when it is otherwise valid', () => {
    const result = validateManifest({
      id: 'kanboss',
      name: 'KanBoss',
      version: '1.0.0',
      engine: { api: 0.9 },
      scope: 'project',
      permissions: [],
      contributes: { help: {} },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([retiredPluginMessage('kanboss')]);
  });

  it('copy has no em dashes', () => {
    for (const id of Object.keys(RETIRED_PLUGINS)) expect(retiredPluginMessage(id)).not.toContain('—');
  });
});
