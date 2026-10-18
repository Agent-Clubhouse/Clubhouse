import { describe, it, expect, vi } from 'vitest';

let stored: { idleTimeoutMinutes: number } = { idleTimeoutMinutes: 30 };
vi.mock('./managed-settings', () => ({
  createManagedSettings: () => ({ getSettings: () => stored, register: vi.fn() }),
}));

import { chatIdleTimeoutMs } from './chat-idle-settings';
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
});
