import { describe, it, expect, vi, beforeEach } from 'vitest';

let stored: { idleTimeoutMinutes: number } = { idleTimeoutMinutes: 30 };
vi.mock('./managed-settings', () => ({
  createManagedSettings: () => ({ getSettings: () => stored, register: vi.fn() }),
}));

import { chatIdleTimeoutMs, clearAgentIdleSleep, onAgentIdleSleepChange, setAgentIdleSleep } from './chat-idle-settings';
import { CHAT_IDLE_SETTINGS } from '../../shared/settings-definitions';

describe('chatIdleTimeoutMs (#2104)', () => {
  it('defaults to 30 minutes', () => {
    expect(CHAT_IDLE_SETTINGS.defaults).toEqual({ idleTimeoutMinutes: 30 });
    expect(chatIdleTimeoutMs()).toBe(30 * 60_000);
  });

  it('converts the chosen minutes, and Never (0) or a bad value to 0', () => {
    stored = { idleTimeoutMinutes: 240 };
    expect(chatIdleTimeoutMs()).toBe(4 * 60 * 60_000);
    stored = { idleTimeoutMinutes: 0 };
    expect(chatIdleTimeoutMs()).toBe(0);
    stored = { idleTimeoutMinutes: Number.NaN };
    expect(chatIdleTimeoutMs()).toBe(0);
  });

  describe('per-agent override (#2143)', () => {
    beforeEach(() => {
      stored = { idleTimeoutMinutes: 30 };
      clearAgentIdleSleep();
    });

    it('uses the agent\'s own value over the app setting', () => {
      setAgentIdleSleep('a1', 15);
      setAgentIdleSleep('a2', 'never');
      expect(chatIdleTimeoutMs('a1')).toBe(15 * 60_000);
      expect(chatIdleTimeoutMs('a2')).toBe(0);
      expect(chatIdleTimeoutMs('a3')).toBe(30 * 60_000);
      expect(chatIdleTimeoutMs()).toBe(30 * 60_000);
      stored = { idleTimeoutMinutes: 0 };
      expect(chatIdleTimeoutMs('a1')).toBe(15 * 60_000);
      expect(chatIdleTimeoutMs('a3')).toBe(0);
    });

    it('goes back to the app setting when cleared', () => {
      setAgentIdleSleep('a1', 240);
      setAgentIdleSleep('a1', undefined);
      expect(chatIdleTimeoutMs('a1')).toBe(30 * 60_000);
      setAgentIdleSleep('a1', 60);
      setAgentIdleSleep('a1', 'inherit');
      expect(chatIdleTimeoutMs('a1')).toBe(30 * 60_000);
    });

    it('tells that agent\'s listeners when its value changes, and only then', () => {
      const listener = vi.fn();
      const other = vi.fn();
      const off = onAgentIdleSleepChange('a1', listener);
      onAgentIdleSleepChange('a2', other);
      setAgentIdleSleep('a1', 15);
      setAgentIdleSleep('a1', 15);
      expect(listener).toHaveBeenCalledTimes(1);
      setAgentIdleSleep('a1', null);
      expect(listener).toHaveBeenCalledTimes(2);
      off();
      setAgentIdleSleep('a1', 60);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(other).not.toHaveBeenCalled();
    });
  });
});
