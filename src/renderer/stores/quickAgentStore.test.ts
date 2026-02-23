import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CompletedQuickAgent } from '../../shared/types';

// ---------- localStorage mock ----------
const storage: Record<string, string> = {};
Object.defineProperty(globalThis, 'window', {
  value: { clubhouse: { platform: 'darwin' } },
  writable: true,
});
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: vi.fn((key: string) => storage[key] ?? null),
    setItem: vi.fn((key: string, val: string) => { storage[key] = val; }),
    removeItem: vi.fn((key: string) => { delete storage[key]; }),
  },
  writable: true,
});

import { useQuickAgentStore } from './quickAgentStore';

// ---------- helpers ----------
function getState() {
  return useQuickAgentStore.getState();
}

function makeCompleted(overrides: Partial<CompletedQuickAgent> = {}): CompletedQuickAgent {
  return {
    id: 'agent_1',
    projectId: 'proj_1',
    name: 'test-agent',
    mission: 'do stuff',
    summary: null,
    filesModified: [],
    exitCode: 0,
    completedAt: Date.now(),
    ...overrides,
  };
}

// ---------- tests ----------
describe('quickAgentStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storage)) delete storage[key];
    useQuickAgentStore.setState({
      completedAgents: {},
      selectedCompletedId: null,
    });
  });

  // ---- defaults ----
  describe('initialization', () => {
    it('has correct defaults', () => {
      const s = getState();
      expect(s.completedAgents).toEqual({});
      expect(s.selectedCompletedId).toBeNull();
    });
  });

  // ---- loadCompleted ----
  describe('loadCompleted', () => {
    it('loads records from localStorage', () => {
      const records = [makeCompleted()];
      storage['quick_completed_proj_1'] = JSON.stringify(records);

      getState().loadCompleted('proj_1');

      expect(getState().completedAgents['proj_1']).toEqual(records);
    });

    it('returns empty array when localStorage is empty', () => {
      getState().loadCompleted('proj_1');

      expect(getState().completedAgents['proj_1']).toEqual([]);
    });

    it('returns empty array on malformed JSON', () => {
      storage['quick_completed_proj_1'] = '{invalid json';

      getState().loadCompleted('proj_1');

      expect(getState().completedAgents['proj_1']).toEqual([]);
    });

    it('preserves records for other projects', () => {
      const existing = [makeCompleted({ projectId: 'proj_0' })];
      useQuickAgentStore.setState({
        completedAgents: { proj_0: existing },
      });

      getState().loadCompleted('proj_1');

      expect(getState().completedAgents['proj_0']).toEqual(existing);
    });
  });

  // ---- addCompleted ----
  describe('addCompleted', () => {
    it('prepends new record', () => {
      const r1 = makeCompleted({ id: 'agent_1', completedAt: 100 });
      const r2 = makeCompleted({ id: 'agent_2', completedAt: 200 });

      getState().addCompleted(r1);
      getState().addCompleted(r2);

      const list = getState().completedAgents['proj_1'];
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('agent_2');
      expect(list[1].id).toBe('agent_1');
    });

    it('persists to localStorage', () => {
      const r = makeCompleted();
      getState().addCompleted(r);

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'quick_completed_proj_1',
        expect.any(String),
      );
      const stored = JSON.parse(storage['quick_completed_proj_1']);
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('agent_1');
    });

    it('handles || [] fallback when project has no prior records', () => {
      // completedAgents is empty, so `get().completedAgents[record.projectId]` is undefined
      // The store uses `|| []` to fall back — this should not throw
      const r = makeCompleted({ projectId: 'proj_new' });

      getState().addCompleted(r);

      expect(getState().completedAgents['proj_new']).toHaveLength(1);
    });
  });

  // ---- dismissCompleted ----
  describe('dismissCompleted', () => {
    it('removes a record by id', () => {
      const r1 = makeCompleted({ id: 'agent_1' });
      const r2 = makeCompleted({ id: 'agent_2' });
      useQuickAgentStore.setState({
        completedAgents: { proj_1: [r1, r2] },
      });

      getState().dismissCompleted('proj_1', 'agent_1');

      const list = getState().completedAgents['proj_1'];
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('agent_2');
    });

    it('persists updated list to localStorage', () => {
      const r = makeCompleted();
      useQuickAgentStore.setState({ completedAgents: { proj_1: [r] } });

      getState().dismissCompleted('proj_1', 'agent_1');

      const stored = JSON.parse(storage['quick_completed_proj_1']);
      expect(stored).toHaveLength(0);
    });

    it('handles || [] fallback when project key is missing', () => {
      // No records for proj_1, uses `|| []`
      getState().dismissCompleted('proj_1', 'nonexistent');

      expect(getState().completedAgents['proj_1']).toEqual([]);
    });
  });

  // ---- clearCompleted ----
  describe('clearCompleted', () => {
    it('clears all records for a project', () => {
      const records = [makeCompleted({ id: 'a1' }), makeCompleted({ id: 'a2' })];
      useQuickAgentStore.setState({ completedAgents: { proj_1: records } });

      getState().clearCompleted('proj_1');

      expect(getState().completedAgents['proj_1']).toEqual([]);
    });

    it('persists empty array to localStorage', () => {
      getState().clearCompleted('proj_1');

      const stored = JSON.parse(storage['quick_completed_proj_1']);
      expect(stored).toEqual([]);
    });

    it('does not affect other projects', () => {
      const records = [makeCompleted({ projectId: 'proj_2' })];
      useQuickAgentStore.setState({
        completedAgents: { proj_1: [makeCompleted()], proj_2: records },
      });

      getState().clearCompleted('proj_1');

      expect(getState().completedAgents['proj_2']).toEqual(records);
    });
  });

  // ---- selectCompleted ----
  describe('selectCompleted', () => {
    it('sets selectedCompletedId', () => {
      getState().selectCompleted('agent_1');
      expect(getState().selectedCompletedId).toBe('agent_1');
    });

    it('clears selectedCompletedId', () => {
      useQuickAgentStore.setState({ selectedCompletedId: 'agent_1' });
      getState().selectCompleted(null);
      expect(getState().selectedCompletedId).toBeNull();
    });
  });

  // ---- selector referential stability ----
  describe('selector stability', () => {
    it('returns the same array reference for unchanged project records', () => {
      const records = [makeCompleted()];
      useQuickAgentStore.setState({ completedAgents: { proj_1: records } });

      const ref1 = getState().completedAgents['proj_1'];
      const ref2 = getState().completedAgents['proj_1'];

      expect(ref1).toBe(ref2);
    });

    it('returns a new array reference after mutation', () => {
      const r = makeCompleted();
      useQuickAgentStore.setState({ completedAgents: { proj_1: [r] } });

      const ref1 = getState().completedAgents['proj_1'];
      getState().addCompleted(makeCompleted({ id: 'agent_2' }));
      const ref2 = getState().completedAgents['proj_1'];

      expect(ref1).not.toBe(ref2);
    });
  });

  // ---- || [] fallback edge cases ----
  describe('|| [] fallback edge cases', () => {
    it('addCompleted with completely empty state does not throw', () => {
      useQuickAgentStore.setState({ completedAgents: {} });

      expect(() => {
        getState().addCompleted(makeCompleted({ projectId: 'proj_x' }));
      }).not.toThrow();

      expect(getState().completedAgents['proj_x']).toHaveLength(1);
    });

    it('dismissCompleted with completely empty state does not throw', () => {
      useQuickAgentStore.setState({ completedAgents: {} });

      expect(() => {
        getState().dismissCompleted('proj_x', 'agent_x');
      }).not.toThrow();

      expect(getState().completedAgents['proj_x']).toEqual([]);
    });

    it('fallback produces a fresh array that does not alias state', () => {
      useQuickAgentStore.setState({ completedAgents: {} });

      // First call creates via fallback
      getState().addCompleted(makeCompleted({ id: 'a1', projectId: 'proj_y' }));
      const ref1 = getState().completedAgents['proj_y'];

      // Second call reads from existing state, not fallback
      getState().addCompleted(makeCompleted({ id: 'a2', projectId: 'proj_y' }));
      const ref2 = getState().completedAgents['proj_y'];

      // Should be new reference (immutable update)
      expect(ref1).not.toBe(ref2);
      expect(ref2).toHaveLength(2);
    });
  });
});
