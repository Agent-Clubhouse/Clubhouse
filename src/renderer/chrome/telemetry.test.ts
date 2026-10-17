import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetRendererTelemetryForTests,
  _setStateForTests,
  flushTelemetry,
  initRendererTelemetry,
} from '../telemetry/facade';
import { getTelemetryView, getTelemetrySurface, recordLongFrame, flushLongFrames, _resetLongFramesForTests } from '../telemetry/long-frames';
import { getAttributeSpec, isKnownEvent } from '../../shared/telemetry/attributes';
import {
  getChromeSurface,
  reportChromeActionFailed,
  reportChromeFeature,
  reportChromeSurface,
  reportChromeView,
  viewForTab,
} from './telemetry';

function bridge() {
  return {
    emit: vi.fn(),
    rendererReady: vi.fn(),
    getState: vi.fn(async () => ({ enabled: false, level: null })),
    onStateChanged: vi.fn(() => () => {}),
  };
}

type Emitted = { t: string; name?: string; attrs: Array<{ key: string; value: unknown }> };

function emitted(b: ReturnType<typeof bridge>): Emitted[] {
  flushTelemetry();
  return b.emit.mock.calls.flatMap(([batch]) => batch.items as Emitted[]);
}

describe('chrome telemetry', () => {
  let b: ReturnType<typeof bridge>;

  beforeEach(() => {
    _resetRendererTelemetryForTests();
    b = bridge();
    initRendererTelemetry(b);
    reportChromeSurface('sidebar_agents');
  });

  afterEach(() => {
    _resetRendererTelemetryForTests();
    _resetLongFramesForTests();
  });

  it('puts the chrome surface on long-frame metrics beside the view', () => {
    _setStateForTests({ enabled: true, level: 'standard' });
    reportChromeView('plugin:files');
    reportChromeSurface('sidebar_list');
    expect(getTelemetrySurface()).toBe('sidebar_list');
    recordLongFrame(80);
    flushLongFrames();
    const counts = emitted(b).filter((i) => i.name === 'clubhouse.renderer.long_frames');
    expect(counts).toHaveLength(1);
    expect(counts[0].attrs).toEqual([
      expect.objectContaining({ key: 'clubhouse.view', value: 'files' }),
      expect.objectContaining({ key: 'clubhouse.ui.surface', value: 'sidebar_list' }),
    ]);
  });

  it('registers its attributes and events', () => {
    expect(getAttributeSpec('clubhouse.ui.surface')?.kind).toBe('enum');
    expect(getAttributeSpec('clubhouse.ui.feature')?.kind).toBe('enum');
    expect(getAttributeSpec('clubhouse.ui.action')?.kind).toBe('enum');
    expect(isKnownEvent('clubhouse.ui.action_failed')).toBe(true);
    expect(isKnownEvent('clubhouse.ui.feature_used')).toBe(true);
  });

  it('maps tabs onto the coarse clubhouse.view enum', () => {
    expect(viewForTab('agents')).toBe('agent');
    expect(viewForTab('settings')).toBe('settings');
    expect(viewForTab('plugin:files')).toBe('files');
    expect(viewForTab('plugin:git')).toBe('git');
    expect(viewForTab('plugin:terminal')).toBe('terminal');
    expect(viewForTab('plugin:canvas')).toBe('canvas');
    expect(viewForTab('plugin:app:canvas')).toBe('canvas');
    expect(viewForTab('plugin:kanboss')).toBe('plugin');
    expect(viewForTab('plugin:app:goobers')).toBe('plugin');
    expect(viewForTab('help')).toBe('other');
  });

  it('sets the long-frame view', () => {
    reportChromeView('plugin:files');
    expect(getTelemetryView()).toBe('files');
  });

  it('emits nothing while telemetry is off', () => {
    reportChromeFeature('tab_select');
    reportChromeActionFailed('add_project', new Error('nope'));
    expect(emitted(b)).toEqual([]);
  });

  it('emits feature_used with the feature and current surface', () => {
    _setStateForTests({ enabled: true, level: 'standard' });
    reportChromeSurface('sidebar_list');
    expect(getChromeSurface()).toBe('sidebar_list');
    reportChromeFeature('tab_select');
    const [item] = emitted(b);
    expect(item.t).toBe('event');
    expect(item.name).toBe('clubhouse.ui.feature_used');
    expect(item.attrs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'clubhouse.ui.feature', value: 'tab_select' }),
      expect.objectContaining({ key: 'clubhouse.ui.surface', value: 'sidebar_list' }),
    ]));
  });

  it('drops feature events at the errors level but keeps action_failed', () => {
    _setStateForTests({ enabled: true, level: 'errors' });
    reportChromeFeature('tab_select');
    reportChromeActionFailed('reorder_projects', new TypeError('bad'));
    const items = emitted(b);
    expect(items.map((i) => i.t)).toEqual(['event', 'exception']);
    expect(items[0].name).toBe('clubhouse.ui.action_failed');
    expect(items[0].attrs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'clubhouse.ui.action', value: 'reorder_projects' }),
    ]));
    // The exception carries the class name only, never the message.
    expect(JSON.stringify(items[1])).not.toContain('bad');
  });

  it('restores the view surface when popups close in any order', async () => {
    const { holdChromeSurface, reportChromeSurface, getChromeSurface } = await import('./telemetry');
    reportChromeSurface('sidebar_list');
    const releaseCard = holdChromeSurface('hover_card');
    const releaseMenu = holdChromeSurface('row_menu');
    expect(getChromeSurface()).toBe('row_menu');
    releaseCard();
    expect(getChromeSurface()).toBe('row_menu');
    releaseMenu();
    expect(getChromeSurface()).toBe('sidebar_list');
    // The view can change under an open popup.
    const release = holdChromeSurface('more_menu');
    reportChromeSurface('sidebar_agents');
    expect(getChromeSurface()).toBe('more_menu');
    release();
    expect(getChromeSurface()).toBe('sidebar_agents');
  });
});
