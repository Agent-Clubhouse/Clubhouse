import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTerminalFit } from './useTerminalFit';

// Track listener registrations so tests can fire events manually
let visibilityListeners: Array<() => void> = [];
let focusListeners: Array<() => void> = [];
let resizeObserverCallbacks: Array<() => void> = [];
const mockDisconnect = vi.fn();

// Mock ResizeObserver
vi.stubGlobal('ResizeObserver', class {
  constructor(cb: () => void) {
    resizeObserverCallbacks.push(cb);
  }
  observe = vi.fn();
  disconnect = mockDisconnect;
  unobserve = vi.fn();
});

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1; });
vi.stubGlobal('cancelAnimationFrame', vi.fn());

describe('useTerminalFit', () => {
  const mockFit = vi.fn();
  const mockFocus = vi.fn();
  const mockResize = vi.fn();

  const terminalRef = { current: { cols: 80, rows: 24, focus: mockFocus } as any };
  const fitAddonRef = { current: { fit: mockFit } as any };
  // Container with non-zero dimensions (clientWidth/clientHeight)
  let containerEl: HTMLDivElement;
  let containerRef: { current: HTMLDivElement };

  beforeEach(() => {
    containerEl = document.createElement('div');
    // jsdom returns 0 for clientWidth/clientHeight by default; stub non-zero values
    Object.defineProperty(containerEl, 'clientWidth', { value: 480, configurable: true });
    Object.defineProperty(containerEl, 'clientHeight', { value: 320, configurable: true });
    containerRef = { current: containerEl };

    mockFit.mockClear();
    mockFocus.mockClear();
    mockResize.mockClear();
    mockDisconnect.mockClear();
    visibilityListeners = [];
    focusListeners = [];
    resizeObserverCallbacks = [];

    window.clubhouse.pty.resize = mockResize;

    // Intercept event listeners
    vi.spyOn(document, 'addEventListener').mockImplementation((event: string, cb: any) => {
      if (event === 'visibilitychange') visibilityListeners.push(cb);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation((event: string, cb: any) => {
      if (event === 'visibilitychange') {
        visibilityListeners = visibilityListeners.filter((l) => l !== cb);
      }
    });
    vi.spyOn(window, 'addEventListener').mockImplementation((event: string, cb: any) => {
      if (event === 'focus') focusListeners.push(cb);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((event: string, cb: any) => {
      if (event === 'focus') {
        focusListeners = focusListeners.filter((l) => l !== cb);
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ResizeObserver', () => {
    it('creates a ResizeObserver on mount', () => {
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));
      expect(resizeObserverCallbacks).toHaveLength(1);
    });

    it('calls fit and resize on ResizeObserver trigger when window has focus', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      mockFit.mockClear();
      mockResize.mockClear();

      resizeObserverCallbacks[0]();

      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockResize).toHaveBeenCalledWith('s1', 80, 24);
    });

    it('calls fit but skips resize when window does not have focus', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      mockFit.mockClear();
      mockResize.mockClear();

      resizeObserverCallbacks[0]();

      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockResize).not.toHaveBeenCalled();
    });

    it('disconnects ResizeObserver on unmount', () => {
      const { unmount } = renderHook(() =>
        useTerminalFit('s1', terminalRef, fitAddonRef, containerRef),
      );
      unmount();
      expect(mockDisconnect).toHaveBeenCalled();
    });
  });

  describe('visibilitychange', () => {
    it('registers a visibilitychange listener', () => {
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));
      expect(visibilityListeners).toHaveLength(1);
    });

    it('calls fit and resize after settle delay when page becomes visible', () => {
      // Only fake setTimeout — requestAnimationFrame is already stubbed globally
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      mockFit.mockClear();
      mockResize.mockClear();

      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      visibilityListeners[0]();

      // Should NOT fire immediately — wake settle delay
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();

      // Advance past the 150ms wake settle delay
      vi.advanceTimersByTime(150);

      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockResize).toHaveBeenCalledWith('s1', 80, 24);

      vi.useRealTimers();
    });

    it('does not re-fit when page becomes hidden', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      mockFit.mockClear();
      mockResize.mockClear();

      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      visibilityListeners[0]();

      vi.advanceTimersByTime(200);

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('cancels pending wake timer on unmount', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { unmount } = renderHook(() =>
        useTerminalFit('s1', terminalRef, fitAddonRef, containerRef),
      );

      mockFit.mockClear();
      mockResize.mockClear();

      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      visibilityListeners[0]();

      // Unmount before the timer fires
      unmount();
      vi.advanceTimersByTime(200);

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('removes visibilitychange listener on unmount', () => {
      const { unmount } = renderHook(() =>
        useTerminalFit('s1', terminalRef, fitAddonRef, containerRef),
      );
      expect(visibilityListeners).toHaveLength(1);
      unmount();
      expect(visibilityListeners).toHaveLength(0);
    });
  });

  describe('window focus', () => {
    it('registers a window focus listener', () => {
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));
      expect(focusListeners).toHaveLength(1);
    });

    it('calls fit and resize when window gains focus', () => {
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      mockFit.mockClear();
      mockResize.mockClear();

      focusListeners[0]();

      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockResize).toHaveBeenCalledWith('s1', 80, 24);
    });

    it('removes window focus listener on unmount', () => {
      const { unmount } = renderHook(() =>
        useTerminalFit('s1', terminalRef, fitAddonRef, containerRef),
      );
      expect(focusListeners).toHaveLength(1);
      unmount();
      expect(focusListeners).toHaveLength(0);
    });
  });

  describe('focused prop', () => {
    it('calls fit, resize, and focus when focused becomes true', () => {
      const { rerender } = renderHook(
        ({ focused }) => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, focused),
        { initialProps: { focused: false } },
      );

      mockFit.mockClear();
      mockResize.mockClear();
      mockFocus.mockClear();

      rerender({ focused: true });

      expect(mockFocus).toHaveBeenCalledTimes(1);
      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockResize).toHaveBeenCalledWith('s1', 80, 24);
    });

    it('does not call fit or resize when focused is false', () => {
      const { rerender } = renderHook(
        ({ focused }) => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, focused),
        { initialProps: { focused: true } },
      );

      mockFit.mockClear();
      mockResize.mockClear();
      mockFocus.mockClear();

      rerender({ focused: false });

      expect(mockFocus).not.toHaveBeenCalled();
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
    });

    it('does not fire when focused stays true across rerenders', () => {
      const { rerender } = renderHook(
        ({ focused }) => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, focused),
        { initialProps: { focused: true } },
      );

      mockFit.mockClear();
      mockResize.mockClear();
      mockFocus.mockClear();

      rerender({ focused: true });

      // No new calls — focused didn't change
      expect(mockFocus).not.toHaveBeenCalled();
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
    });
  });

  describe('onResize callback', () => {
    it('uses custom onResize callback instead of window.clubhouse.pty.resize', () => {
      const customResize = vi.fn();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() =>
        useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, false, customResize),
      );

      mockFit.mockClear();
      mockResize.mockClear();

      resizeObserverCallbacks[0]();

      expect(customResize).toHaveBeenCalledWith('s1', 80, 24);
      expect(mockResize).not.toHaveBeenCalled();
    });

    it('uses custom onResize on visibility change', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const customResize = vi.fn();
      renderHook(() =>
        useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, false, customResize),
      );

      mockResize.mockClear();

      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      visibilityListeners[0]();
      vi.advanceTimersByTime(150);

      expect(customResize).toHaveBeenCalledWith('s1', 80, 24);
      expect(mockResize).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('uses custom onResize on pane focus', () => {
      const customResize = vi.fn();
      const { rerender } = renderHook(
        ({ focused }) =>
          useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, focused, customResize),
        { initialProps: { focused: false } },
      );

      mockResize.mockClear();

      rerender({ focused: true });

      expect(customResize).toHaveBeenCalledWith('s1', 80, 24);
      expect(mockResize).not.toHaveBeenCalled();
    });

    it('falls back to window.clubhouse.pty.resize when onResize is undefined', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() =>
        useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, false, undefined),
      );

      mockFit.mockClear();
      mockResize.mockClear();

      resizeObserverCallbacks[0]();

      expect(mockResize).toHaveBeenCalledWith('s1', 80, 24);
    });
  });

  describe('zero-dimension guard', () => {
    it('skips fit and resize when container has zero width', () => {
      const zeroWidthEl = document.createElement('div');
      Object.defineProperty(zeroWidthEl, 'clientWidth', { value: 0, configurable: true });
      Object.defineProperty(zeroWidthEl, 'clientHeight', { value: 320, configurable: true });
      const zeroRef = { current: zeroWidthEl };

      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, zeroRef));

      mockFit.mockClear();
      mockResize.mockClear();

      resizeObserverCallbacks[0]();

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
    });

    it('skips fit and resize when container has zero height', () => {
      const zeroHeightEl = document.createElement('div');
      Object.defineProperty(zeroHeightEl, 'clientWidth', { value: 480, configurable: true });
      Object.defineProperty(zeroHeightEl, 'clientHeight', { value: 0, configurable: true });
      const zeroRef = { current: zeroHeightEl };

      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, zeroRef));

      mockFit.mockClear();
      mockResize.mockClear();

      resizeObserverCallbacks[0]();

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
    });

    it('skips fit and resize when container ref becomes null', () => {
      const mutableRef = { current: containerEl as HTMLDivElement | null };
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, mutableRef));

      mockFit.mockClear();
      mockResize.mockClear();

      // Null out the container ref after mount
      mutableRef.current = null;
      resizeObserverCallbacks[0]();

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
    });
  });

  describe('viewport scroll preservation', () => {
    let viewportEl: HTMLDivElement;

    function addViewport(scrollTop: number, scrollHeight: number, clientHeight: number) {
      viewportEl = document.createElement('div');
      viewportEl.classList.add('xterm-viewport');
      Object.defineProperty(viewportEl, 'scrollHeight', { value: scrollHeight, configurable: true });
      Object.defineProperty(viewportEl, 'clientHeight', { value: clientHeight, configurable: true });
      viewportEl.scrollTop = scrollTop;
      containerEl.appendChild(viewportEl);
    }

    it('restores scrollTop when user is scrolled up from bottom', () => {
      // scrollHeight=1000, clientHeight=200, scrollTop=300 → user is scrolled up
      addViewport(300, 1000, 200);
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      // Simulate fit() resetting scrollTop to 0 (the bug)
      mockFit.mockImplementation(() => {
        viewportEl.scrollTop = 0;
      });

      mockFit.mockClear();
      resizeObserverCallbacks[0]();

      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(viewportEl.scrollTop).toBe(300);
    });

    it('keeps viewport at bottom when user was already at bottom', () => {
      // scrollHeight=1000, clientHeight=200, scrollTop=800 → at bottom
      addViewport(800, 1000, 200);
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      // Simulate fit() changing scrollHeight (reflow) and scrollTop
      mockFit.mockImplementation(() => {
        Object.defineProperty(viewportEl, 'scrollHeight', { value: 1200, configurable: true });
        viewportEl.scrollTop = 500;
      });

      mockFit.mockClear();
      resizeObserverCallbacks[0]();

      expect(mockFit).toHaveBeenCalledTimes(1);
      // Should scroll to the new bottom: 1200 - 200 = 1000
      expect(viewportEl.scrollTop).toBe(1000);
    });

    it('preserves scroll position during pane focus fit', () => {
      addViewport(400, 1000, 200);
      mockFit.mockImplementation(() => {
        viewportEl.scrollTop = 0;
      });

      const { rerender } = renderHook(
        ({ focused }) => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, focused),
        { initialProps: { focused: false } },
      );

      mockFit.mockClear();
      rerender({ focused: true });

      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(viewportEl.scrollTop).toBe(400);
    });

    it('works gracefully when no .xterm-viewport element exists', () => {
      // No viewport element — save/restore should be no-ops
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      mockFit.mockClear();
      resizeObserverCallbacks[0]();

      // Should still call fit without errors
      expect(mockFit).toHaveBeenCalledTimes(1);
    });
  });

  describe('null-safety', () => {
    it('does nothing when container ref is null', () => {
      const nullContainer = { current: null };
      renderHook(() =>
        useTerminalFit('s1', terminalRef, fitAddonRef, nullContainer),
      );
      // No ResizeObserver created
      expect(resizeObserverCallbacks).toHaveLength(0);
    });

    it('does nothing in rAF when terminal ref is null', () => {
      const nullTerminal = { current: null };
      renderHook(() =>
        useTerminalFit('s1', nullTerminal as any, fitAddonRef, containerRef),
      );

      mockFit.mockClear();
      mockResize.mockClear();

      // Trigger a resize
      resizeObserverCallbacks[0]();

      // Early return — neither fit nor resize called
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
    });

    it('does nothing in rAF when fitAddon ref is null', () => {
      const nullFitAddon = { current: null };
      renderHook(() =>
        useTerminalFit('s1', terminalRef, nullFitAddon as any, containerRef),
      );

      mockFit.mockClear();
      mockResize.mockClear();

      resizeObserverCallbacks[0]();

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
    });
  });
});
