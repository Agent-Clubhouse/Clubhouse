import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------- localStorage mock ----------
let storage: Record<string, string> = {};
const setItem = vi.fn((key: string, val: string) => { storage[key] = val; });
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, val: string) => setItem(key, val),
    removeItem: (key: string) => { delete storage[key]; },
  },
  writable: true,
});

import { useBulletinReadStore } from './bulletinReadStore';

const KEY = 'bulletin_read_gp1';

function reset(): void {
  storage = {};
  setItem.mockImplementation((key: string, val: string) => { storage[key] = val; });
  useBulletinReadStore.setState({ lastRead: {} });
}

describe('bulletinReadStore', () => {
  beforeEach(reset);

  it('starts with no read state for an unknown project', () => {
    expect(useBulletinReadStore.getState().getLastRead('gp1')).toEqual({});
  });

  it('persists a per-topic last read timestamp to localStorage', () => {
    useBulletinReadStore.getState().markTopicRead('gp1', 'general', '2026-07-25T10:00:00.000Z');

    expect(useBulletinReadStore.getState().getLastRead('gp1')).toEqual({
      general: '2026-07-25T10:00:00.000Z',
    });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      general: '2026-07-25T10:00:00.000Z',
    });
  });

  it('keeps read state per project', () => {
    useBulletinReadStore.getState().markTopicRead('gp1', 'general', '2026-07-25T10:00:00.000Z');
    useBulletinReadStore.getState().markTopicRead('gp2', 'general', '2026-07-25T11:00:00.000Z');

    expect(useBulletinReadStore.getState().getLastRead('gp1').general).toBe('2026-07-25T10:00:00.000Z');
    expect(useBulletinReadStore.getState().getLastRead('gp2').general).toBe('2026-07-25T11:00:00.000Z');
  });

  it('keeps read state per topic within a project', () => {
    useBulletinReadStore.getState().markTopicsRead('gp1', [
      { topic: 'general', timestamp: '2026-07-25T10:00:00.000Z' },
      { topic: 'tasks', timestamp: '2026-07-25T11:00:00.000Z' },
    ]);

    expect(useBulletinReadStore.getState().getLastRead('gp1')).toEqual({
      general: '2026-07-25T10:00:00.000Z',
      tasks: '2026-07-25T11:00:00.000Z',
    });
  });

  it('advances the timestamp forward', () => {
    const s = useBulletinReadStore.getState();
    s.markTopicRead('gp1', 'general', '2026-07-25T10:00:00.000Z');
    s.markTopicRead('gp1', 'general', '2026-07-25T12:00:00.000Z');

    expect(useBulletinReadStore.getState().getLastRead('gp1').general).toBe('2026-07-25T12:00:00.000Z');
  });

  it('never moves the timestamp backwards', () => {
    const s = useBulletinReadStore.getState();
    s.markTopicRead('gp1', 'general', '2026-07-25T12:00:00.000Z');
    s.markTopicRead('gp1', 'general', '2026-07-25T10:00:00.000Z');

    expect(useBulletinReadStore.getState().getLastRead('gp1').general).toBe('2026-07-25T12:00:00.000Z');
  });

  it('ignores empty and unparseable timestamps', () => {
    const s = useBulletinReadStore.getState();
    s.markTopicsRead('gp1', [
      { topic: 'general', timestamp: '' },
      { topic: 'tasks', timestamp: 'not-a-date' },
      { topic: '', timestamp: '2026-07-25T10:00:00.000Z' },
    ]);

    expect(useBulletinReadStore.getState().getLastRead('gp1')).toEqual({});
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('does not write when nothing changed', () => {
    useBulletinReadStore.getState().markTopicRead('gp1', 'general', '2026-07-25T12:00:00.000Z');
    const before = useBulletinReadStore.getState().lastRead;

    useBulletinReadStore.getState().markTopicRead('gp1', 'general', '2026-07-25T10:00:00.000Z');

    // Same object identity — no state update, so no needless re-render.
    expect(useBulletinReadStore.getState().lastRead).toBe(before);
  });

  it('hydrates read state from localStorage', () => {
    localStorage.setItem(KEY, JSON.stringify({ general: '2026-07-25T10:00:00.000Z' }));

    useBulletinReadStore.getState().loadLastRead('gp1');

    expect(useBulletinReadStore.getState().getLastRead('gp1')).toEqual({
      general: '2026-07-25T10:00:00.000Z',
    });
  });

  it('survives a reload — persisted state is readable by a fresh load', () => {
    useBulletinReadStore.getState().markTopicRead('gp1', 'general', '2026-07-25T10:00:00.000Z');
    useBulletinReadStore.setState({ lastRead: {} });

    useBulletinReadStore.getState().loadLastRead('gp1');

    expect(useBulletinReadStore.getState().getLastRead('gp1').general).toBe('2026-07-25T10:00:00.000Z');
  });

  it('ignores corrupt localStorage payloads', () => {
    localStorage.setItem(KEY, 'not json');
    useBulletinReadStore.getState().loadLastRead('gp1');
    expect(useBulletinReadStore.getState().getLastRead('gp1')).toEqual({});

    localStorage.setItem(KEY, JSON.stringify(['array', 'payload']));
    useBulletinReadStore.getState().loadLastRead('gp1');
    expect(useBulletinReadStore.getState().getLastRead('gp1')).toEqual({});
  });

  it('drops non-string values from a partially corrupt payload', () => {
    localStorage.setItem(KEY, JSON.stringify({ general: '2026-07-25T10:00:00.000Z', tasks: 42 }));
    useBulletinReadStore.getState().loadLastRead('gp1');

    expect(useBulletinReadStore.getState().getLastRead('gp1')).toEqual({
      general: '2026-07-25T10:00:00.000Z',
    });
  });

  it('clears read state for a project', () => {
    useBulletinReadStore.getState().markTopicRead('gp1', 'general', '2026-07-25T10:00:00.000Z');
    useBulletinReadStore.getState().clearLastRead('gp1');

    expect(useBulletinReadStore.getState().getLastRead('gp1')).toEqual({});
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('does not throw when localStorage writes fail', () => {
    setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });

    expect(() =>
      useBulletinReadStore.getState().markTopicRead('gp1', 'general', '2026-07-25T10:00:00.000Z'),
    ).not.toThrow();
    // In-memory state still advances so the session behaves correctly.
    expect(useBulletinReadStore.getState().getLastRead('gp1').general).toBe('2026-07-25T10:00:00.000Z');
  });
});
