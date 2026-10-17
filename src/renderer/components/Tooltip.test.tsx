import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Tooltip, TOOLTIP_DELAY_MS, formatShortcut } from './Tooltip';
import { Modal } from './Modal';
import { useKeyboardShortcutsStore } from '../stores/keyboardShortcutsStore';

describe('formatShortcut', () => {
  it('uses glyphs in macOS order with no separators', () => {
    expect(formatShortcut('Meta+Alt+P', 'darwin')).toBe('⌥⌘P');
    expect(formatShortcut('Meta+Shift+k', 'darwin')).toBe('⇧⌘K');
    expect(formatShortcut('Meta+ArrowUp', 'darwin')).toBe('⌘↑');
    expect(formatShortcut('Meta++', 'darwin')).toBe('⌘+');
  });

  it('spells out modifiers elsewhere, mapping Meta to Ctrl', () => {
    expect(formatShortcut('Meta+Alt+P', 'win32')).toBe('Ctrl+Alt+P');
    expect(formatShortcut('Meta+Shift+k', 'linux')).toBe('Ctrl+Shift+K');
    expect(formatShortcut('Escape', 'linux')).toBe('Esc');
    expect(formatShortcut('Meta++', 'win32')).toBe('Ctrl++');
  });
});

describe('Tooltip', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    // Let the skip-delay window from one test expire before the next.
    act(() => { vi.advanceTimersByTime(1000); });
    vi.useRealTimers();
  });

  const renderTip = (props: Partial<React.ComponentProps<typeof Tooltip>> = {}) => render(
    <Tooltip content="Pop out" {...props}>
      <button type="button" aria-label="Pop out agent">P</button>
    </Tooltip>,
  );

  it('opens after the delay on hover and closes on leave', () => {
    renderTip();
    const trigger = screen.getByRole('button');
    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Pop out');
    expect(tip.parentElement).toBe(document.body);
    expect(tip.className).toContain('z-tooltip');
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('does not open if the pointer leaves before the delay', () => {
    renderTip();
    const trigger = screen.getByRole('button');
    fireEvent.mouseEnter(trigger);
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 100); });
    fireEvent.mouseLeave(trigger);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens at once on keyboard focus and closes on blur', () => {
    renderTip();
    const trigger = screen.getByRole('button');
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }); trigger.focus(); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => { trigger.blur(); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not open on focus that follows a click', () => {
    renderTip();
    const trigger = screen.getByRole('button');
    fireEvent.mouseDown(document.body);
    act(() => { trigger.focus(); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on Esc', () => {
    renderTip();
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }); screen.getByRole('button').focus(); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on click and stays closed until the pointer leaves', () => {
    renderTip();
    const trigger = screen.getByRole('button');
    fireEvent.mouseEnter(trigger);
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    fireEvent.pointerDown(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(trigger);
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(trigger);
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('skips the delay when moving straight to another tooltip', () => {
    render(
      <>
        <Tooltip content="One"><button type="button">1</button></Tooltip>
        <Tooltip content="Two"><button type="button">2</button></Tooltip>
      </>,
    );
    const [a, b] = screen.getAllByRole('button');
    fireEvent.mouseEnter(a);
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    fireEvent.mouseLeave(a);
    fireEvent.mouseEnter(b);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Two');
  });

  it('shows a shortcut with platform modifiers', () => {
    renderTip({ shortcut: 'Meta+Alt+P' });
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }); screen.getByRole('button').focus(); });
    const expected = window.clubhouse.platform === 'darwin' ? '⌥⌘P' : 'Ctrl+Alt+P';
    expect(screen.getByRole('tooltip').querySelector('kbd')).toHaveTextContent(expected);
  });

  it('resolves a shortcut action from the keyboard shortcuts store', () => {
    const [id, def] = Object.entries(useKeyboardShortcutsStore.getState().shortcuts)[0];
    renderTip({ shortcutAction: id });
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }); screen.getByRole('button').focus(); });
    expect(screen.getByRole('tooltip').querySelector('kbd')).toHaveTextContent(formatShortcut(def.currentBinding));
  });

  it('skips aria-describedby when it would only repeat the aria-label', () => {
    render(<Tooltip content="Pop out"><button type="button" aria-label="Pop out">P</button></Tooltip>);
    const trigger = screen.getByRole('button');
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }); trigger.focus(); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('keeps the child handlers and ref', () => {
    const onMouseEnter = vi.fn();
    const onFocus = vi.fn();
    const ref = { current: null as HTMLButtonElement | null };
    render(<Tooltip content="Tip"><button type="button" ref={ref} onMouseEnter={onMouseEnter} onFocus={onFocus}>x</button></Tooltip>);
    const trigger = screen.getByRole('button');
    fireEvent.mouseEnter(trigger);
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }); trigger.focus(); });
    expect(onMouseEnter).toHaveBeenCalled();
    expect(onFocus).toHaveBeenCalled();
    expect(ref.current).toBe(trigger);
  });

  it('renders only the child when disabled', () => {
    renderTip({ disabled: true });
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }); screen.getByRole('button').focus(); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('inside a Modal, Esc dismisses the tooltip and leaves the Modal open', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} aria-label="Dialog">
        <Tooltip content="Tip"><button type="button">x</button></Tooltip>
      </Modal>,
    );
    const trigger = screen.getByRole('button', { name: 'x' });
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }); trigger.focus(); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('with onlyWhenTruncated, opens only when the text overflows', () => {
    render(<Tooltip content="A long project name" onlyWhenTruncated><span tabIndex={0}>A long project name</span></Tooltip>);
    const el = screen.getByText('A long project name');
    fireEvent.mouseEnter(el);
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseLeave(el);
    Object.defineProperty(el, 'scrollWidth', { value: 200, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
    fireEvent.mouseEnter(el);
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('A long project name');
  });
});

