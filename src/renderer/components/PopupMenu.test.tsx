import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PopupMenu, type MenuEntry } from './PopupMenu';

const items = (onSelect = vi.fn()): MenuEntry[] => [
  { id: 'rename', label: 'Rename', shortcut: 'F2', onSelect },
  { id: 'dup', label: 'Duplicate', disabled: true, onSelect },
  { id: 'pop', label: 'Pop out', onSelect },
  { id: 'sep', separator: true },
  { id: 'delete', label: 'Delete…', danger: true, onSelect },
];

function renderMenu(onClose = vi.fn(), onSelect = vi.fn()) {
  render(<PopupMenu items={items(onSelect)} position={{ x: 10, y: 10 }} label="Agent menu" testId="m" onClose={onClose} />);
  return { onClose, onSelect };
}

describe('PopupMenu', () => {
  it('is a labelled menu portaled to body at the dropdown layer', () => {
    renderMenu();
    const menu = screen.getByRole('menu', { name: 'Agent menu' });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain('z-dropdown');
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('focuses the first enabled item and moves with arrows, Home and End, skipping disabled', () => {
    renderMenu();
    const menu = screen.getByRole('menu');
    expect(document.activeElement).toBe(screen.getByTestId('m-rename'));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('m-pop'));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('m-delete'));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('m-rename'));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('m-delete'));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByTestId('m-rename'));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('m-delete'));
  });

  it('selects an item and closes', () => {
    const { onClose, onSelect } = renderMenu();
    fireEvent.click(screen.getByTestId('m-pop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks on disabled items', () => {
    const { onClose, onSelect } = renderMenu();
    fireEvent.click(screen.getByTestId('m-dup'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId('m-dup')).toHaveAttribute('aria-disabled', 'true');
  });

  it('closes on Esc, Tab and a click outside', () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('draws 28px rows, red danger items and the shortcut', () => {
    renderMenu();
    expect(screen.getByTestId('m-rename').className).toContain('h-7');
    expect(screen.getByTestId('m-rename').querySelector('kbd')).toHaveTextContent('F2');
    expect(screen.getByTestId('m-delete').className).toContain('text-ctp-red');
  });

  it('returns focus to the trigger after closing from the menu', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<PopupMenu items={items()} position={{ x: 0, y: 0 }} label="M" testId="m" onClose={() => {}} />);
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
