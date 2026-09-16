import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useGoobersStore, isGoobersConnectionState, initGoobersListener } from './goobersStore';
import type { GoobersConnectionState } from '../../shared/goobers-types';

const validState: GoobersConnectionState = {
  configured: true,
  instanceRoot: '/instance/root',
  rootIdentity: 'abc123',
  daemon: {
    state: 'not-running',
    address: null,
    pid: null,
    version: null,
    startedAt: null,
    lastTickAgeMillis: null,
    draining: false,
  },
  connection: 'idle',
  stream: 'unavailable',
  instance: null,
  health: null,
  apiCompatible: true,
  lastError: null,
  lastUpdatedAt: '2026-09-16T00:00:00.000Z',
};

const mockGetState = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockOnStateChanged = vi.fn(() => () => {});

vi.stubGlobal('window', {
  clubhouse: {
    goobers: {
      getState: mockGetState,
      connect: mockConnect,
      disconnect: mockDisconnect,
      onStateChanged: mockOnStateChanged,
    },
  },
});

describe('goobersStore', () => {
  beforeEach(() => {
    useGoobersStore.setState({ state: null, loaded: false, loadError: null });
    vi.clearAllMocks();
  });

  describe('isGoobersConnectionState', () => {
    it('accepts a valid GoobersConnectionState', () => {
      expect(isGoobersConnectionState(validState)).toBe(true);
    });

    it('rejects null', () => {
      expect(isGoobersConnectionState(null)).toBe(false);
    });

    it('rejects a non-object', () => {
      expect(isGoobersConnectionState('not an object')).toBe(false);
      expect(isGoobersConnectionState(42)).toBe(false);
      expect(isGoobersConnectionState(undefined)).toBe(false);
    });

    it("rejects an object missing 'connection'", () => {
      const { connection: _connection, ...rest } = validState;
      expect(isGoobersConnectionState(rest)).toBe(false);
    });

    it("rejects an object missing 'daemon'", () => {
      const { daemon: _daemon, ...rest } = validState;
      expect(isGoobersConnectionState(rest)).toBe(false);
    });
  });

  describe('loadState', () => {
    it('sets state and loaded, clears loadError on success', async () => {
      mockGetState.mockResolvedValue(validState);

      await useGoobersStore.getState().loadState();

      const state = useGoobersStore.getState();
      expect(state.state).toEqual(validState);
      expect(state.loaded).toBe(true);
      expect(state.loadError).toBeNull();
    });

    it('sets loadError and logs when the IPC call throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGetState.mockRejectedValue(new Error('IPC channel closed'));

      await useGoobersStore.getState().loadState();

      const state = useGoobersStore.getState();
      expect(state.loaded).toBe(true);
      expect(state.loadError).toBe('IPC channel closed');
      expect(state.state).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith('[goobers] loadState failed:', 'IPC channel closed');

      consoleSpy.mockRestore();
    });

    it('sets loadError when the payload is a valid response but an unrecognized shape', async () => {
      mockGetState.mockResolvedValue({ unexpected: true });

      await useGoobersStore.getState().loadState();

      const state = useGoobersStore.getState();
      expect(state.loaded).toBe(true);
      expect(state.loadError).toBe('goobers:get-state returned an unrecognized shape');
      expect(state.state).toBeNull();
    });
  });

  describe('connect', () => {
    it('sets state on a valid shape', async () => {
      mockConnect.mockResolvedValue(validState);

      await useGoobersStore.getState().connect();

      expect(useGoobersStore.getState().state).toEqual(validState);
    });

    it('does not set state on an invalid shape', async () => {
      mockConnect.mockResolvedValue({ unexpected: true });

      await useGoobersStore.getState().connect();

      expect(useGoobersStore.getState().state).toBeNull();
    });
  });

  describe('initGoobersListener', () => {
    it('updates the store on a valid broadcast', () => {
      let capturedCallback: ((state: unknown) => void) | undefined;
      mockOnStateChanged.mockImplementation((cb: (state: unknown) => void) => {
        capturedCallback = cb;
        return () => {};
      });

      initGoobersListener();
      capturedCallback?.(validState);

      expect(useGoobersStore.getState().state).toEqual(validState);
    });

    it('ignores an invalid broadcast payload', () => {
      useGoobersStore.setState({ state: validState });
      let capturedCallback: ((state: unknown) => void) | undefined;
      mockOnStateChanged.mockImplementation((cb: (state: unknown) => void) => {
        capturedCallback = cb;
        return () => {};
      });

      initGoobersListener();
      capturedCallback?.({ unexpected: true });

      expect(useGoobersStore.getState().state).toEqual(validState);
    });

    it('returns a working unsubscribe', () => {
      const unsubscribeSpy = vi.fn();
      mockOnStateChanged.mockReturnValue(unsubscribeSpy);

      const unsubscribe = initGoobersListener();
      unsubscribe();

      expect(unsubscribeSpy).toHaveBeenCalled();
    });

    // M11: a subsequent broadcast carrying `lastError: null` must fully
    // replace the previous error state, never leave a stale error behind
    // merged with fresher fields (the panel's self-contradictory "Tried: X
    // ... 'Y' was not found" bug traced to main never broadcasting the
    // corrected state — this pins the renderer side of that contract).
    it('clears a previous error when a later broadcast carries lastError: null', () => {
      const erroredState: GoobersConnectionState = {
        ...validState,
        lastError: { code: 'binary-not-found', message: "'definitely-not-goobers' was not found on PATH" },
      };
      useGoobersStore.setState({ state: erroredState });

      let capturedCallback: ((state: unknown) => void) | undefined;
      mockOnStateChanged.mockImplementation((cb: (state: unknown) => void) => {
        capturedCallback = cb;
        return () => {};
      });

      initGoobersListener();
      capturedCallback?.({ ...validState, lastError: null });

      expect(useGoobersStore.getState().state?.lastError).toBeNull();
    });
  });
});
