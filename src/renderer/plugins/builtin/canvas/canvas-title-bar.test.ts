import { describe, it, expect } from 'vitest';

/**
 * Canvas title bar type label formatting.
 *
 * The canvas view title bar shows a type badge with sentence-case text
 * (first letter capitalised, hyphens replaced with spaces) instead of
 * the previous ALL-CAPS monospace style.
 */

function formatViewType(raw: string): string {
  return raw.charAt(0).toUpperCase() + raw.slice(1).replace(/-/g, ' ');
}

describe('Canvas title bar — type label formatting', () => {
  it('capitalises first letter of simple types', () => {
    expect(formatViewType('agent')).toBe('Agent');
    expect(formatViewType('file')).toBe('File');
    expect(formatViewType('browser')).toBe('Browser');
  });

  it('replaces hyphens with spaces', () => {
    expect(formatViewType('git-diff')).toBe('Git diff');
  });

  it('handles plugin widget type names', () => {
    expect(formatViewType('timeline')).toBe('Timeline');
    expect(formatViewType('my-widget')).toBe('My widget');
  });

  it('handles single character types', () => {
    expect(formatViewType('x')).toBe('X');
  });

  it('handles already capitalised input', () => {
    expect(formatViewType('Agent')).toBe('Agent');
  });
});

/**
 * Plugin widget type extraction — mirrors the CanvasView logic for
 * extracting the widget type from a pluginWidgetType string like
 * "canvas:my-plugin:timeline".
 */
function extractPluginWidgetType(pluginWidgetType: string): string {
  return pluginWidgetType.split(':').pop() || '';
}

describe('Canvas title bar — plugin widget type extraction', () => {
  it('extracts last segment from colon-delimited string', () => {
    expect(extractPluginWidgetType('canvas:my-plugin:timeline')).toBe('timeline');
  });

  it('returns full string when no colons present', () => {
    expect(extractPluginWidgetType('timeline')).toBe('timeline');
  });

  it('handles double-colon edge case', () => {
    expect(extractPluginWidgetType('a::b')).toBe('b');
  });

  it('returns empty string for trailing colon', () => {
    expect(extractPluginWidgetType('a:b:')).toBe('');
  });
});
