import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { WidgetPicker, type PickerSection } from './WidgetPicker';

function sections(onSelect: (id: string) => void): PickerSection[] {
  return [
    {
      id: 'awake',
      rows: [
        { id: 'a', label: 'gallant-swift', testId: 'row-a', onSelect: () => onSelect('a') },
        { id: 'b', label: 'curious-tapir', detail: 'review-toolbar', testId: 'row-b', onSelect: () => onSelect('b') },
      ],
    },
    {
      id: 'sleeping',
      label: 'Sleeping',
      rows: [
        { id: 'c', label: 'bold-falcon', testId: 'row-c', onSelect: () => onSelect('c') },
      ],
    },
  ];
}

function renderPicker(extra: Partial<React.ComponentProps<typeof WidgetPicker>> = {}) {
  const onSelect = vi.fn();
  render(<WidgetPicker searchPlaceholder="Find an agent" emptyText="No agents" sections={sections(onSelect)} {...extra} />);
  return { search: screen.getByTestId('canvas-picker-search'), onSelect };
}

const shown = () => screen.queryAllByRole('option').map((o) => o.getAttribute('data-testid'));
const highlighted = () => screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.getAttribute('data-testid');

describe('WidgetPicker search', () => {
  it('shows every row and section label with no query', () => {
    renderPicker();
    expect(shown()).toEqual(['row-a', 'row-b', 'row-c']);
    expect(screen.getByText('Sleeping')).toBeTruthy();
  });

  it('filters rows by label, ignoring case', () => {
    const { search } = renderPicker();
    fireEvent.change(search, { target: { value: 'FALCON' } });
    expect(shown()).toEqual(['row-c']);
  });

  it('matches the detail line too', () => {
    const { search } = renderPicker();
    fireEvent.change(search, { target: { value: 'toolbar' } });
    expect(shown()).toEqual(['row-b']);
  });

  it('hides a section label once none of its rows match', () => {
    const { search } = renderPicker();
    fireEvent.change(search, { target: { value: 'swift' } });
    expect(shown()).toEqual(['row-a']);
    expect(screen.queryByText('Sleeping')).toBeNull();
  });

  it('says No matches when nothing matches', () => {
    const { search } = renderPicker();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(shown()).toEqual([]);
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('shows the empty text and no search field when there are no rows at all', () => {
    render(<WidgetPicker searchPlaceholder="Find an agent" emptyText="No agents" sections={[]} />);
    expect(screen.getByText('No agents')).toBeTruthy();
    expect(screen.queryByTestId('canvas-picker-search')).toBeNull();
  });
});

describe('WidgetPicker keyboard', () => {
  it('starts on the first row and moves with the arrow keys, wrapping at both ends', () => {
    const { search } = renderPicker();
    expect(highlighted()).toBe('row-a');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(highlighted()).toBe('row-b');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(highlighted()).toBe('row-c');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(highlighted()).toBe('row-a');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(highlighted()).toBe('row-c');
  });

  it('selects the highlighted row with Enter', () => {
    const { search, onSelect } = renderPicker();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('moves the highlight to the first match when the query changes', () => {
    const { search, onSelect } = renderPicker();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.change(search, { target: { value: 'falcon' } });
    expect(highlighted()).toBe('row-c');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('marks the keys it handles, so the canvas does not pan under it', () => {
    const { search } = renderPicker();
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      search.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('does nothing on Enter when nothing matches', () => {
    const { search, onSelect } = renderPicker();
    fireEvent.change(search, { target: { value: 'zzz' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('follows the mouse', () => {
    renderPicker();
    fireEvent.mouseEnter(screen.getByTestId('row-c'));
    expect(highlighted()).toBe('row-c');
  });
});

describe('WidgetPicker footer and Back', () => {
  it('runs the footer action and the Back row', () => {
    const onFooter = vi.fn();
    const onBack = vi.fn();
    renderPicker({ footer: { label: 'New agent', testId: 'footer', onSelect: onFooter }, onBack, backLabel: 'Projects' });
    fireEvent.click(screen.getByTestId('footer'));
    fireEvent.click(screen.getByText('Projects'));
    expect(onFooter).toHaveBeenCalled();
    expect(onBack).toHaveBeenCalled();
  });
});
