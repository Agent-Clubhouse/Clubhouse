import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTR } from '../../shared/telemetry/attributes';
import { _resetRendererTelemetryForTests, _setStateForTests, flushTelemetry, initRendererTelemetry } from './facade';
import { _resetLongFramesForTests, setTelemetrySurface, setTelemetryView } from './long-frames';
import {
  COALESCE_MS,
  DEFAULT_HANG_THRESHOLD_MS,
  HANG_THRESHOLD_STORAGE_KEY,
  MAX_LINES_PER_MINUTE,
  _flushUiPerfForTests,
  _resetUiPerfForTests,
  _setUiPerfSinkForTests,
  getHangThresholdMs,
  getLastInteraction,
  handleEventEntries,
  handleLongFrame,
  isObservingFrames,
  noteInteraction,
  scriptSourceOf,
  scrubInvoker,
  scrubScriptUrl,
  startUiPerf,
  type UiPerfLine,
} from './ui-perf';

const emit = vi.fn();
let lines: UiPerfLine[];

function items() {
  flushTelemetry();
  return emit.mock.calls.flatMap((c) => c[0].items) as Array<{ t: string; name: string; value?: number; attrs: unknown[] }>;
}

beforeEach(() => {
  emit.mockClear();
  lines = [];
  initRendererTelemetry({ emit, rendererReady: vi.fn(), getState: async () => ({ enabled: false, level: null }), onStateChanged: () => () => {} });
  _setStateForTests({ enabled: false, level: null });
  _setUiPerfSinkForTests((l) => lines.push(l));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.removeItem(HANG_THRESHOLD_STORAGE_KEY);
  _resetUiPerfForTests();
  _resetLongFramesForTests();
  _resetRendererTelemetryForTests();
});

describe('hang log with telemetry off', () => {
  it('turns a burst of long frames into exactly one line, with no telemetry', () => {
    vi.useFakeTimers();
    setTelemetryView('agent');
    setTelemetrySurface('sidebar_agents');
    const button = document.createElement('button');
    button.setAttribute('data-testid', 'sidebar-fold-sleeping');
    button.textContent = 'Secret agent name';
    document.body.append(button);
    noteInteraction('click', button);

    handleLongFrame({
      duration: 640,
      scripts: [
        { invoker: 'BUTTON.onclick', invokerType: 'event-listener', sourceFunctionName: 'toggleFold', sourceURL: 'file:///Users/alice/Clubhouse.app/main_window/index.js?x=1', duration: 580 },
        { invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback', sourceURL: 'file:///Users/alice/x/vendor.js', duration: 20 },
      ],
    });
    handleLongFrame({ duration: 260 });
    handleLongFrame({ duration: 90 }); // under the threshold: not a hang
    expect(lines).toHaveLength(0);
    vi.advanceTimersByTime(COALESCE_MS);

    expect(lines).toHaveLength(1);
    const { msg, meta } = lines[0];
    expect(msg).toBe('Long frames: 640ms in agent/sidebar_agents');
    expect(meta).toMatchObject({
      kind: 'long_frame', count: 2, maxMs: 640, totalMs: 900, thresholdMs: DEFAULT_HANG_THRESHOLD_MS,
      view: 'agent', surface: 'sidebar_agents',
      interaction: { type: 'click', target: 'sidebar-fold-sleeping' },
    });
    expect(meta.scripts).toEqual([
      { invoker: 'BUTTON.onclick', invokerType: 'event-listener', fn: 'toggleFold', source: 'file:index.js', ms: 580 },
      { invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback', source: 'file:vendor.js', ms: 20 },
    ]);
    // Never text content or a full path.
    expect(JSON.stringify(lines)).not.toContain('Secret agent name');
    expect(JSON.stringify(lines)).not.toContain('/Users/alice');
    expect(items()).toEqual([]);
    button.remove();
  });

  it('leaves out an interaction from long before the burst', () => {
    noteInteraction('keydown', document.body, 'Enter', performance.now() - 10_000);
    handleLongFrame({ duration: 300 });
    _flushUiPerfForTests();
    expect(lines[0].meta.interaction).toBeUndefined();
  });

  it('rate-limits lines and reports what it held back on the next one', () => {
    for (let i = 0; i < MAX_LINES_PER_MINUTE + 2; i++) {
      handleLongFrame({ duration: 300 });
      _flushUiPerfForTests(1_000 + i);
    }
    expect(lines).toHaveLength(MAX_LINES_PER_MINUTE);
    handleLongFrame({ duration: 300 });
    _flushUiPerfForTests(1_000 + 61_000);
    expect(lines).toHaveLength(MAX_LINES_PER_MINUTE + 1);
    expect(lines[MAX_LINES_PER_MINUTE].meta.suppressed).toBe(2);
  });

  it('logs slow interactions apart from long frames', () => {
    handleEventEntries([
      { name: 'pointerdown', duration: 40, interactionId: 7 },
      { name: 'click', duration: 320, interactionId: 7 },
      { name: 'keydown', duration: 24, interactionId: 8 },
    ]);
    _flushUiPerfForTests();
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toMatch(/^Slow interaction: 320ms/);
    expect(lines[0].meta).toMatchObject({ kind: 'slow_interaction', count: 1, maxMs: 320 });
    expect(items()).toEqual([]);
  });

  it('reads the threshold override from storage when it starts', () => {
    localStorage.setItem(HANG_THRESHOLD_STORAGE_KEY, '120');
    startUiPerf();
    expect(getHangThresholdMs()).toBe(120);
    handleLongFrame({ duration: 130 });
    _flushUiPerfForTests();
    expect(lines).toHaveLength(1);
  });

  it('ignores a threshold override under 50ms', () => {
    localStorage.setItem(HANG_THRESHOLD_STORAGE_KEY, '10');
    startUiPerf();
    expect(getHangThresholdMs()).toBe(DEFAULT_HANG_THRESHOLD_MS);
  });
});

describe('hang and interaction telemetry', () => {
  beforeEach(() => {
    _setStateForTests({ enabled: true, level: 'standard' });
  });

  it('sends one clubhouse.ui.hang per burst with bounded attributes only', () => {
    setTelemetryView('canvas');
    noteInteraction('wheel', document.body);
    handleLongFrame({ duration: 450, scripts: [{ sourceURL: 'clubhouse-plugin://my-plugin/dist/main.js', duration: 400 }] });
    handleLongFrame({ duration: 220 });
    _flushUiPerfForTests();
    const hangs = items().filter((i) => i.name === 'clubhouse.ui.hang');
    expect(hangs).toEqual([{
      t: 'event',
      name: 'clubhouse.ui.hang',
      attrs: [
        ATTR.view('canvas'),
        ATTR.uiHangDurationMs(450),
        ATTR.uiHangFrames(2),
        ATTR.uiHangScriptSource('plugin'),
        ATTR.uiInteractionType('wheel'),
      ],
    }]);
    // The plugin keeps its id locally; telemetry only says "plugin".
    expect(lines[0].meta.scripts).toEqual([{ source: 'clubhouse-plugin://my-plugin/…/main.js', ms: 400 }]);
  });

  it('sends one clubhouse.ui.slow_interaction per burst, keeping the target id local (#2307)', () => {
    setTelemetryView('agent');
    setTelemetrySurface('sidebar_agents');
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'sidebar-agent-row');
    row.textContent = 'Secret agent name';
    document.body.append(row);
    noteInteraction('click', row);
    handleEventEntries([
      { name: 'click', duration: 260, interactionId: 11 },
      { name: 'keydown', duration: 410, interactionId: 12 },
    ]);
    _flushUiPerfForTests();
    const slow = items().filter((i) => i.name === 'clubhouse.ui.slow_interaction');
    expect(slow).toEqual([{
      t: 'event',
      name: 'clubhouse.ui.slow_interaction',
      attrs: [
        ATTR.view('agent'),
        ATTR.uiSurface('sidebar_agents'),
        ATTR.uiSlowInteractionDurationMs(410),
        ATTR.uiSlowInteractionCount(2),
        // The slowest interaction's own type, not the last input before the burst.
        ATTR.uiInteractionType('keydown'),
      ],
    }]);
    expect(JSON.stringify(items())).not.toContain('sidebar-agent-row');
    expect(JSON.stringify(items())).not.toContain('Secret');
    expect(lines[0].meta.interaction).toMatchObject({ type: 'click', target: 'sidebar-agent-row' });
  });

  it('shares the six-a-minute cap with clubhouse.ui.hang', () => {
    for (let i = 0; i < MAX_LINES_PER_MINUTE + 2; i++) {
      if (i % 2) handleLongFrame({ duration: 300 });
      else handleEventEntries([{ name: 'click', duration: 300, interactionId: 100 + i }]);
      _flushUiPerfForTests(1_000 + i);
    }
    const events = items().filter((i) => i.name === 'clubhouse.ui.slow_interaction' || i.name === 'clubhouse.ui.hang');
    expect(events).toHaveLength(MAX_LINES_PER_MINUTE);
  });

  it('measures each interaction once, by its longest entry, per surface', () => {
    setTelemetryView('agent');
    setTelemetrySurface('sidebar_agents');
    handleEventEntries([
      { name: 'pointerdown', duration: 24, interactionId: 3 },
      { name: 'click', duration: 56, interactionId: 3 },
      { name: 'mousemove', duration: 80 }, // not an interaction
    ]);
    handleEventEntries([{ name: 'click', duration: 60, interactionId: 3 }]); // same interaction, later callback
    handleEventEntries([{ name: 'keyup', duration: 32, interactionId: 4 }]);
    const metric = items().filter((i) => i.name === 'clubhouse.ui.interaction.duration');
    expect(metric.map((m) => [m.value, m.attrs])).toEqual([
      [0.056, [ATTR.view('agent'), ATTR.uiSurface('sidebar_agents'), ATTR.uiInteractionType('click')]],
      [0.032, [ATTR.view('agent'), ATTR.uiSurface('sidebar_agents'), ATTR.uiInteractionType('keydown')]],
    ]);
  });
});

describe('interaction tracking', () => {
  it('keeps a stable target id and named keys only, never text or characters', () => {
    const row = document.createElement('div');
    row.setAttribute('data-tree-key', 'agent:a1');
    const label = document.createElement('span');
    label.textContent = 'my private project';
    row.append(label);
    noteInteraction('keydown', label, 'p');
    expect(getLastInteraction()).toMatchObject({ type: 'keydown', target: 'tree:agent:a1' });
    expect(getLastInteraction()).not.toHaveProperty('key');
    noteInteraction('keydown', label, 'Escape');
    expect(getLastInteraction()?.key).toBe('Escape');
    noteInteraction('keydown', label, '😀');
    expect(getLastInteraction()).not.toHaveProperty('key');
    noteInteraction('keydown', label, 'Dead');
    expect(getLastInteraction()?.key).toBe('Dead');
    noteInteraction('click', document.createElement('section'));
    expect(getLastInteraction()?.target).toBe('section');
  });

  it('records input from window capture listeners once started', () => {
    startUiPerf();
    const b = document.createElement('button');
    b.setAttribute('data-testid', 'details-card-mcp-toggle');
    document.body.append(b);
    b.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(getLastInteraction()).toMatchObject({ type: 'click', target: 'details-card-mcp-toggle' });
    b.remove();
  });
});

describe('script attribution', () => {
  it('scrubs URLs to scheme and file name, keeping the plugin id', () => {
    expect(scrubScriptUrl('file:///C:/Users/bob/AppData/Clubhouse/resources/app/main_window/index.js')).toBe('file:index.js');
    expect(scrubScriptUrl('http://localhost:3000/main_window/index.js?hot=1')).toBe('http:index.js');
    expect(scrubScriptUrl('clubhouse-plugin://board/src/view.js')).toBe('clubhouse-plugin://board/…/view.js');
    expect(scrubScriptUrl('')).toBeUndefined();
    expect(scrubScriptUrl('not a url')).toBeUndefined();
  });

  it('scrubs a script invoker, which is the script URL for script entries', () => {
    expect(scrubInvoker('file:///Users/alice/.clubhouse/plugins/board/main.js', 'classic-script')).toBe('file:main.js');
    expect(scrubInvoker('clubhouse-plugin://board/dist/main.js', 'module-script')).toBe('clubhouse-plugin://board/…/main.js');
    expect(scrubInvoker('file:///Users/alice/x.js', 'event-listener')).toBe('file:x.js');
    expect(scrubInvoker('BUTTON#save.onclick', 'event-listener')).toBe('BUTTON#save.onclick');
    expect(scrubInvoker('garbage', 'classic-script')).toBe('script');
  });

  it('classifies whose script it was', () => {
    expect(scriptSourceOf('clubhouse-plugin://board/x.js')).toBe('plugin');
    expect(scriptSourceOf('file:///Users/a/.clubhouse/plugins/board/x.js')).toBe('plugin');
    expect(scriptSourceOf('file:///C:\\Users\\a\\.clubhouse\\plugins\\board\\x.js')).toBe('plugin');
    expect(scriptSourceOf('chrome-extension://abc/x.js')).toBe('extension');
    expect(scriptSourceOf('file:///app/main_window/index.js')).toBe('app');
    expect(scriptSourceOf(undefined)).toBe('none');
  });
});

describe('observers', () => {
  it('installs the long-frame observer whether or not telemetry is on', () => {
    const observed: string[] = [];
    class FakeObserver {
      static supportedEntryTypes = ['long-animation-frame', 'event'];
      observe = vi.fn((o: { type: string }) => observed.push(o.type));
      disconnect = vi.fn();
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    startUiPerf();
    expect(isObservingFrames()).toBe(true);
    expect(observed).toEqual(['long-animation-frame', 'event']);
  });

  it('falls back to longtask', () => {
    const observed: string[] = [];
    class FakeObserver {
      static supportedEntryTypes = ['longtask'];
      observe = vi.fn((o: { type: string }) => observed.push(o.type));
      disconnect = vi.fn();
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    startUiPerf();
    expect(observed).toEqual(['longtask']);
  });
});
