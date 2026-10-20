import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTerminalFit, isTerminalAtBottom, RESIZE_DEBOUNCE_MS } from './useTerminalFit';
import { _resetSizeOwnersForTests } from './pty-size-owner';

vi.mock('../../plugins/renderer-logger', () => ({
  rendererLog: vi.fn(),
}));

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

  const mockScrollToBottom = vi.fn();
  const bufferState = { viewportY: 0, baseY: 0 };
  const terminalRef = {
    current: {
      cols: 80,
      rows: 24,
      focus: mockFocus,
      scrollToBottom: mockScrollToBottom,
      buffer: { active: bufferState },
    } as any,
  };
  const fitAddonRef = { current: { fit: mockFit } as any };
  // Container with non-zero dimensions (clientWidth/clientHeight)
  let containerEl: HTMLDivElement;
  let containerRef: { current: HTMLDivElement };

  /** Fire the ResizeObserver and let its debounced PTY resize go out. */
  function fireResizeObserver(index = 0) {
    resizeObserverCallbacks[index]!();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    _resetSizeOwnersForTests();
    containerEl = document.createElement('div');
    // jsdom returns 0 for clientWidth/clientHeight by default; stub non-zero values
    Object.defineProperty(containerEl, 'clientWidth', { value: 480, configurable: true });
    Object.defineProperty(containerEl, 'clientHeight', { value: 320, configurable: true });
    containerRef = { current: containerEl };

    mockFit.mockReset();
    mockFocus.mockClear();
    mockScrollToBottom.mockClear();
    bufferState.viewportY = 0;
    bufferState.baseY = 0;
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
    vi.useRealTimers();
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

      fireResizeObserver();

      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockResize).toHaveBeenCalledWith('s1', 80, 24);
    });

    it('calls fit but skips resize when window does not have focus', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      mockFit.mockClear();
      mockResize.mockClear();

      fireResizeObserver();

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
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
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

      // Focus is called twice: once before fit (so the user sees a focused
      // cursor immediately) and once after fit (to recover from the blur
      // that xterm's reflow can cause — see issue #1387).
      expect(mockFocus).toHaveBeenCalledTimes(2);
      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockResize).toHaveBeenCalledWith('s1', 80, 24);
    });

    it('refocuses xterm after fit() to recover from reflow-induced blur', () => {
      // Regression for issue #1387: switching back to an actively-streaming
      // agent left the terminal unresponsive because fit() blurs xterm's
      // helper textarea but the pane-focus effect did not refocus afterwards.
      const callOrder: string[] = [];
      mockFit.mockImplementation(() => callOrder.push('fit'));
      mockFocus.mockImplementation(() => callOrder.push('focus'));

      const { rerender } = renderHook(
        ({ focused }) => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, focused),
        { initialProps: { focused: false } },
      );

      callOrder.length = 0;
      mockFit.mockClear();
      mockFocus.mockClear();

      rerender({ focused: true });

      // Pre-fit focus (immediate cursor), fit (reflow blurs textarea),
      // post-fit focus (recovery).
      expect(callOrder).toEqual(['focus', 'fit', 'focus']);
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

      fireResizeObserver();

      expect(customResize).toHaveBeenCalledWith('s1', 80, 24);
      expect(mockResize).not.toHaveBeenCalled();
    });

    it('uses custom onResize on visibility change', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
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

      fireResizeObserver();

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

      fireResizeObserver();

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

      fireResizeObserver();

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
      fireResizeObserver();

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
    });
  });

  describe('replay gate (readyRef)', () => {
    it('skips every trigger while the mount is still replaying', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const readyRef = { current: false };
      const { rerender } = renderHook(
        ({ focused }) => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, focused, undefined, { readyRef }),
        { initialProps: { focused: false } },
      );
      fireResizeObserver();
      focusListeners[0]();
      rerender({ focused: true });
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();

      readyRef.current = true;
      fireResizeObserver();
      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockResize).toHaveBeenCalledWith('s1', 80, 24);
    });
  });

  describe('hidden container on pane focus (#2323)', () => {
    it('does not fit or resize the PTY when a focused pane is hidden', () => {
      Object.defineProperty(containerEl, 'clientWidth', { value: 0, configurable: true });
      Object.defineProperty(containerEl, 'clientHeight', { value: 0, configurable: true });
      const { rerender } = renderHook(
        ({ focused }) => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, focused),
        { initialProps: { focused: false } },
      );
      rerender({ focused: true });
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
      // The xterm still takes keyboard focus.
      expect(mockFocus).toHaveBeenCalled();
    });
  });

  describe('one size owner per session (#2322)', () => {
    function makeView(cols: number, rows: number) {
      const term = {
        cols,
        rows,
        focus: vi.fn(),
        scrollToBottom: vi.fn(),
        resize: vi.fn(function (this: { cols: number; rows: number }, c: number, r: number) {
          this.cols = c;
          this.rows = r;
        }),
        buffer: { active: { viewportY: 0, baseY: 0 } },
      };
      const fit = vi.fn();
      const el = document.createElement('div');
      Object.defineProperty(el, 'clientWidth', { value: 400, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
      return {
        term,
        fit,
        el,
        terminalRef: { current: term as any },
        fitAddonRef: { current: { fit } as any },
        containerRef: { current: el },
      };
    }

    it('lets only the owner resize the PTY; the other view follows the PTY size', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const main = makeView(120, 40);
      const card = makeView(50, 12);
      const ptySizeRef = { current: { cols: 120, rows: 40 } };
      renderHook(() => useTerminalFit('s1', main.terminalRef, main.fitAddonRef, main.containerRef, false, undefined, { ptySizeRef }));
      renderHook(() => useTerminalFit('s1', card.terminalRef, card.fitAddonRef, card.containerRef, false, undefined, { ptySizeRef }));
      mockResize.mockClear();

      // Every trigger on the card: no PTY resize, and it renders at the PTY size.
      fireResizeObserver(1);
      for (const listener of focusListeners) listener();
      expect(mockResize).toHaveBeenCalledTimes(1); // the main view's window-focus re-assert
      expect(mockResize).toHaveBeenCalledWith('s1', 120, 40);
      expect(card.fit).not.toHaveBeenCalled();
      expect([card.term.cols, card.term.rows]).toEqual([120, 40]);
    });

    it('moves ownership to the view that gains pane focus, and back', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const main = makeView(120, 40);
      const card = makeView(50, 12);
      const ptySizeRef = { current: { cols: 120, rows: 40 } as { cols: number; rows: number } };
      const mainHook = renderHook(
        ({ focused }) => useTerminalFit('s1', main.terminalRef, main.fitAddonRef, main.containerRef, focused, undefined, { ptySizeRef }),
        { initialProps: { focused: true } },
      );
      const cardHook = renderHook(
        ({ focused }) => useTerminalFit('s1', card.terminalRef, card.fitAddonRef, card.containerRef, focused, undefined, { ptySizeRef }),
        { initialProps: { focused: false } },
      );
      mockResize.mockClear();

      mainHook.rerender({ focused: false });
      cardHook.rerender({ focused: true });
      expect(card.fit).toHaveBeenCalled();
      expect(mockResize).toHaveBeenLastCalledWith('s1', 50, 12);

      // The card now owns the size: the main view's resize observer is quiet.
      mockResize.mockClear();
      ptySizeRef.current = { cols: 50, rows: 12 };
      fireResizeObserver(0);
      expect(mockResize).not.toHaveBeenCalled();
      expect([main.term.cols, main.term.rows]).toEqual([50, 12]);
    });

    it('claims ownership when the user focuses a view that has no focused prop', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const main = makeView(120, 40);
      const card = makeView(50, 12);
      renderHook(() => useTerminalFit('s1', main.terminalRef, main.fitAddonRef, main.containerRef));
      renderHook(() => useTerminalFit('s1', card.terminalRef, card.fitAddonRef, card.containerRef));
      mockResize.mockClear();

      card.el.dispatchEvent(new FocusEvent('focusin'));
      expect(mockResize).toHaveBeenCalledWith('s1', 50, 12);
    });

    it('ignores DOM focus from a mount that is still replaying', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const main = makeView(120, 40);
      const card = makeView(50, 12);
      const cardReady = { current: false };
      renderHook(() => useTerminalFit('s1', main.terminalRef, main.fitAddonRef, main.containerRef));
      renderHook(() => useTerminalFit('s1', card.terminalRef, card.fitAddonRef, card.containerRef, false, undefined, { readyRef: cardReady }));
      mockResize.mockClear();

      card.el.dispatchEvent(new FocusEvent('focusin')); // the mount's term.focus()
      cardReady.current = true;
      fireResizeObserver(0);
      expect(mockResize).toHaveBeenCalledWith('s1', 120, 40);
      expect(mockResize).not.toHaveBeenCalledWith('s1', 50, 12);
    });

    it('does not send from a background window when it becomes visible', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      const main = makeView(120, 40);
      renderHook(() => useTerminalFit('s1', main.terminalRef, main.fitAddonRef, main.containerRef));
      mockResize.mockClear();
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      visibilityListeners.forEach((listener) => listener());
      vi.advanceTimersByTime(200);
      expect(mockResize).not.toHaveBeenCalled();
    });

    it('hands the size to the remaining view when the owner unmounts', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const main = makeView(120, 40);
      const card = makeView(50, 12);
      const mainHook = renderHook(() => useTerminalFit('s1', main.terminalRef, main.fitAddonRef, main.containerRef));
      renderHook(() => useTerminalFit('s1', card.terminalRef, card.fitAddonRef, card.containerRef));
      mockResize.mockClear();

      mainHook.unmount();
      expect(mockResize).toHaveBeenCalledWith('s1', 50, 12);
    });

    it('debounces container resizes into one PTY resize at the final size', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const main = makeView(100, 30);
      renderHook(() => useTerminalFit('s1', main.terminalRef, main.fitAddonRef, main.containerRef));
      mockResize.mockClear();

      // A drag: many observer callbacks, each fit, one resize at the end.
      for (let cols = 100; cols > 60; cols -= 5) {
        main.fit.mockImplementationOnce(() => { main.term.cols = cols; });
        resizeObserverCallbacks[0]!();
        vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS / 4);
      }
      expect(mockResize).not.toHaveBeenCalled();
      vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
      expect(mockResize).toHaveBeenCalledTimes(1);
      expect(mockResize).toHaveBeenCalledWith('s1', 65, 30);
    });

    it('syncToPty adopts the PTY size in every view, owner included (#2359)', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const main = makeView(120, 40);
      const card = makeView(50, 12);
      const ptySizeRef = { current: { cols: 90, rows: 30 } };
      const mainHook = renderHook(() => useTerminalFit('s1', main.terminalRef, main.fitAddonRef, main.containerRef, false, undefined, { ptySizeRef }));
      const cardHook = renderHook(() => useTerminalFit('s1', card.terminalRef, card.fitAddonRef, card.containerRef, false, undefined, { ptySizeRef }));

      mainHook.result.current.syncToPty();
      cardHook.result.current.syncToPty();
      expect([main.term.cols, main.term.rows]).toEqual([90, 30]);
      expect([card.term.cols, card.term.rows]).toEqual([90, 30]);
    });

    it('owner proposes its size to the PTY and resizes its xterm only when the PTY follows', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const main = makeView(120, 40);
      (main.fitAddonRef.current as any).proposeDimensions = () => ({ cols: 60, rows: 20 });
      const ptySizeRef = { current: { cols: 120, rows: 40 } };
      const hook = renderHook(() => useTerminalFit('s1', main.terminalRef, main.fitAddonRef, main.containerRef, false, undefined, { ptySizeRef }));
      mockResize.mockClear();

      for (const listener of focusListeners) listener();
      expect(mockResize).toHaveBeenCalledWith('s1', 60, 20);
      // Output still in flight was produced at 120 columns: keep parsing it there.
      expect(main.fit).not.toHaveBeenCalled();
      expect([main.term.cols, main.term.rows]).toEqual([120, 40]);

      // PTY.RESIZED arrives after that output.
      ptySizeRef.current = { cols: 60, rows: 20 };
      hook.result.current.syncToPty();
      expect([main.term.cols, main.term.rows]).toEqual([60, 20]);
    });
  });

  describe('viewport scroll preservation', () => {
    // xterm 6 scrolls virtually — `.xterm-viewport` scrollTop is always 0 —
    // so scroll state is read from term.buffer.active (viewportY vs baseY).

    it('re-pins to bottom when a reflow leaves a bottom-following view short', () => {
      bufferState.viewportY = 100;
      bufferState.baseY = 100;
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      // Reflow to fewer columns wraps lines: baseY grows, viewport lags
      mockFit.mockImplementation(() => { bufferState.baseY = 130; });
      mockScrollToBottom.mockClear();
      fireResizeObserver();

      expect(mockFit).toHaveBeenCalled();
      expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('leaves a scrolled-up viewport to xterm (no forced scroll)', () => {
      bufferState.viewportY = 40;
      bufferState.baseY = 100;
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      mockFit.mockImplementation(() => { bufferState.baseY = 130; });
      mockScrollToBottom.mockClear();
      fireResizeObserver();

      expect(mockFit).toHaveBeenCalled();
      expect(mockScrollToBottom).not.toHaveBeenCalled();
    });

    it('re-pins to bottom during pane focus fit', () => {
      bufferState.viewportY = 50;
      bufferState.baseY = 50;
      mockFit.mockImplementation(() => { bufferState.baseY = 60; });

      const { rerender } = renderHook(
        ({ focused }) => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef, focused),
        { initialProps: { focused: false } },
      );

      mockScrollToBottom.mockClear();
      rerender({ focused: true });

      expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('does not scroll when fit keeps the viewport at the bottom', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => useTerminalFit('s1', terminalRef, fitAddonRef, containerRef));

      mockScrollToBottom.mockClear();
      fireResizeObserver();

      expect(mockFit).toHaveBeenCalled();
      expect(mockScrollToBottom).not.toHaveBeenCalled();
    });
  });

  describe('isTerminalAtBottom', () => {
    it('compares viewportY against baseY', () => {
      const mk = (viewportY: number, baseY: number) => ({ buffer: { active: { viewportY, baseY } } }) as any;
      expect(isTerminalAtBottom(mk(10, 10))).toBe(true);
      expect(isTerminalAtBottom(mk(0, 0))).toBe(true);
      expect(isTerminalAtBottom(mk(3, 10))).toBe(false);
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
      fireResizeObserver();

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

      fireResizeObserver();

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResize).not.toHaveBeenCalled();
    });
  });
});
