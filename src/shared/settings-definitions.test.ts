import { describe, it, expect } from 'vitest';
import { settingsChannels, type SettingsDefinition } from './settings-definitions';

describe('settings-definitions', () => {
  describe('settingsChannels', () => {
    it('derives get channel from key', () => {
      expect(settingsChannels('clipboard').get).toBe('settings:clipboard:get');
    });

    it('derives save channel from key', () => {
      expect(settingsChannels('clipboard').save).toBe('settings:clipboard:save');
    });

    it('handles multi-word keys', () => {
      const ch = settingsChannels('clubhouse-mode');
      expect(ch.get).toBe('settings:clubhouse-mode:get');
      expect(ch.save).toBe('settings:clubhouse-mode:save');
    });

    it('returns distinct channels for different keys', () => {
      const a = settingsChannels('badge');
      const b = settingsChannels('clipboard');
      expect(a.get).not.toBe(b.get);
      expect(a.save).not.toBe(b.save);
    });
  });

  describe('SettingsDefinition type', () => {
    it('can define a typed settings definition', () => {
      interface TestSettings {
        enabled: boolean;
        count: number;
      }

      const def: SettingsDefinition<TestSettings> = {
        key: 'test',
        filename: 'test-settings.json',
        defaults: { enabled: false, count: 0 },
      };

      expect(def.key).toBe('test');
      expect(def.filename).toBe('test-settings.json');
      expect(def.defaults.enabled).toBe(false);
      expect(def.defaults.count).toBe(0);
    });
  });
});
