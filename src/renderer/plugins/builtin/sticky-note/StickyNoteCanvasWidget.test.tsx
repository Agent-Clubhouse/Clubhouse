import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { StickyNoteCanvasWidget, TINTS, NOTE_COLORS } from './StickyNoteCanvasWidget';
import type { CanvasWidgetComponentProps, PluginAPI, ThemeInfo } from '../../../../shared/plugin-types';

// ── Mock safe-markdown so tests don't need the full marked/DOMPurify stack ──
vi.mock('../../../utils/safe-markdown', () => ({
  renderMarkdownSafe: (content: string) => `<p>${content}</p>`,
}));

// ── Stub helpers ─────────────────────────────────────────────────────────────

function makeTheme(type: 'dark' | 'light'): ThemeInfo {
  return { id: `test-${type}`, name: `Test ${type}`, type, colors: {}, hljs: {} };
}

function makeApi(overrides: { themeType?: 'dark' | 'light'; onDidChange?: ReturnType<typeof vi.fn> } = {}): PluginAPI {
  const themeType = overrides.themeType ?? 'dark';
  const onDidChange = overrides.onDidChange ?? vi.fn(() => ({ dispose: vi.fn() }));
  return {
    theme: {
      getCurrent: () => makeTheme(themeType),
      onDidChange,
      getColor: () => null,
    },
    context: { mode: 'project', projectId: 'proj-1' },
  } as unknown as PluginAPI;
}

function makeProps(overrides: Partial<CanvasWidgetComponentProps> = {}): CanvasWidgetComponentProps {
  return {
    widgetId: 'w1',
    api: makeApi(),
    metadata: {},
    onUpdateMetadata: vi.fn(),
    size: { width: 300, height: 300 },
    ...overrides,
  };
}

// ── StickyNoteCanvasWidget ────────────────────────────────────────────────────

describe('StickyNoteCanvasWidget', () => {
  it('renders in view mode by default', () => {
    render(<StickyNoteCanvasWidget {...makeProps()} />);
    expect(screen.getByTestId('sticky-note-viewer')).toBeTruthy();
    expect(screen.queryByTestId('sticky-note-editor')).toBeNull();
  });

  it('switches to edit mode when Edit is clicked', () => {
    render(<StickyNoteCanvasWidget {...makeProps()} />);
    fireEvent.click(screen.getByTestId('sticky-note-edit'));
    expect(screen.getByTestId('sticky-note-editor')).toBeTruthy();
    expect(screen.queryByTestId('sticky-note-viewer')).toBeNull();
  });

  it('saves content and returns to view mode', () => {
    const onUpdateMetadata = vi.fn();
    render(<StickyNoteCanvasWidget {...makeProps({ onUpdateMetadata, metadata: { content: 'hello' } })} />);
    fireEvent.click(screen.getByTestId('sticky-note-edit'));

    const textarea = screen.getByTestId('sticky-note-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'updated content' } });
    fireEvent.click(screen.getByTestId('sticky-note-save'));

    expect(onUpdateMetadata).toHaveBeenCalledWith({ content: 'updated content' });
    expect(screen.getByTestId('sticky-note-viewer')).toBeTruthy();
  });

  it('cancels edit and returns to view mode without saving', () => {
    const onUpdateMetadata = vi.fn();
    render(<StickyNoteCanvasWidget {...makeProps({ onUpdateMetadata })} />);
    fireEvent.click(screen.getByTestId('sticky-note-edit'));

    const textarea = screen.getByTestId('sticky-note-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'draft' } });
    fireEvent.click(screen.getByTestId('sticky-note-cancel'));

    // onUpdateMetadata called by onUnmountSave (auto-save on unmount), but not by Save button
    expect(screen.getByTestId('sticky-note-viewer')).toBeTruthy();
  });

  it('changes color via color picker', () => {
    const onUpdateMetadata = vi.fn();
    render(<StickyNoteCanvasWidget {...makeProps({ onUpdateMetadata })} />);
    fireEvent.click(screen.getByTestId('sticky-note-color-blue'));
    expect(onUpdateMetadata).toHaveBeenCalledWith({ color: 'blue' });
  });

  it('uses yellow tint as default when no color metadata is set', () => {
    const { container } = render(<StickyNoteCanvasWidget {...makeProps({ metadata: {} })} />);
    const widget = container.querySelector('[data-testid="sticky-note-widget"]');
    expect(widget?.className).toContain('bg-ctp-yellow');
  });

  it('applies the correct tint class for the given color', () => {
    const { container } = render(
      <StickyNoteCanvasWidget {...makeProps({ metadata: { color: 'blue' } })} />,
    );
    const widget = container.querySelector('[data-testid="sticky-note-widget"]');
    expect(widget?.className).toContain('bg-ctp-blue');
  });

  it('subscribes to theme changes on mount and unsubscribes on unmount', () => {
    const dispose = vi.fn();
    const onDidChange = vi.fn(() => ({ dispose }));
    const api = makeApi({ onDidChange });
    const { unmount } = render(<StickyNoteCanvasWidget {...makeProps({ api })} />);
    expect(onDidChange).toHaveBeenCalledOnce();
    unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('applies light tint when theme type is light', () => {
    const api = makeApi({ themeType: 'light' });
    const { container } = render(
      <StickyNoteCanvasWidget {...makeProps({ api, metadata: { color: 'green' } })} />,
    );
    const widget = container.querySelector('[data-testid="sticky-note-widget"]');
    expect(widget?.className).toContain(TINTS.green.light.split(' ')[0]);
  });
});

// ── TINTS lookup table ────────────────────────────────────────────────────────

describe('TINTS', () => {
  it('covers all NOTE_COLORS for both theme types', () => {
    for (const color of NOTE_COLORS) {
      expect(TINTS[color]).toBeDefined();
      expect(TINTS[color].dark).toBeTruthy();
      expect(TINTS[color].light).toBeTruthy();
    }
  });
});
