import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ZoneCard } from './ZoneCard';
import type { ZoneCanvasView } from './canvas-types';

vi.mock('../../../themes', () => ({
  getTheme: (id: string) =>
    id === 'catppuccin-mocha'
      ? { name: 'Mocha', colors: { base: '#1e1e2e', mantle: '#181825', text: '#cdd6f4', accent: '#89b4fa' } }
      : id === 'catppuccin-latte'
        ? { name: 'Latte', colors: { base: '#eff1f5', mantle: '#e6e9ef', text: '#4c4f69', accent: '#1e66f5' } }
        : undefined,
  getAllThemeIds: () => ['catppuccin-mocha', 'catppuccin-latte'],
}));

vi.mock('./InlineRename', () => ({
  InlineRename: ({ value }: { value: string }) => <span data-testid="inline-rename">{value}</span>,
}));

function makeZone(overrides?: Partial<ZoneCanvasView>): ZoneCanvasView {
  return {
    id: 'zone-1',
    type: 'zone',
    position: { x: 100, y: 200 },
    size: { width: 600, height: 400 },
    title: 'Test Zone',
    displayName: 'Test Zone',
    zIndex: 5,
    themeId: 'catppuccin-mocha',
    containedViewIds: [],
    metadata: {},
    ...overrides,
  };
}

function renderZoneCard(overrides?: Partial<ZoneCanvasView>) {
  const handlers = {
    onRename: vi.fn(),
    onThemeChange: vi.fn(),
    onDelete: vi.fn(),
    onDragStart: vi.fn(),
    onStartWireDrag: vi.fn(),
  };
  const result = render(
    <ZoneCard zone={makeZone(overrides)} mcpEnabled={false} {...handlers} />,
  );
  return { ...result, ...handlers };
}

describe('ZoneCard', () => {
  beforeEach(() => {
    // Clean up any portaled elements from previous tests
    document.body.querySelectorAll('[data-testid="zone-theme-picker"]').forEach((el) => el.remove());
  });

  it('renders at zone position with correct z-index', () => {
    const { getByTestId } = renderZoneCard();
    const el = getByTestId('zone-card-zone-1');
    expect(el.style.left).toBe('100px');
    expect(el.style.top).toBe('200px');
    expect(el.style.zIndex).toBe('6'); // zone.zIndex + 1
  });

  describe('theme picker z-index', () => {
    it('renders theme picker into document.body via portal', () => {
      const { getByTitle } = renderZoneCard();
      fireEvent.click(getByTitle('Zone theme'));

      // Picker should be in document.body, not inside the zone card
      const picker = document.querySelector('[data-testid="zone-theme-picker"]');
      expect(picker).toBeTruthy();
      expect(picker!.parentElement).toBe(document.body);
    });

    it('theme picker has z-index above canvas cards', () => {
      const { getByTitle } = renderZoneCard();
      fireEvent.click(getByTitle('Zone theme'));

      const picker = document.querySelector('[data-testid="zone-theme-picker"]') as HTMLElement;
      expect(picker.style.zIndex).toBe('10000');
    });

    it('theme picker uses fixed positioning', () => {
      const { getByTitle } = renderZoneCard();
      fireEvent.click(getByTitle('Zone theme'));

      const picker = document.querySelector('[data-testid="zone-theme-picker"]') as HTMLElement;
      expect(picker.classList.contains('fixed')).toBe(true);
    });
  });

  describe('theme picker scroll isolation', () => {
    it('stops wheel events from propagating to canvas', () => {
      const { getByTitle } = renderZoneCard();
      fireEvent.click(getByTitle('Zone theme'));

      const picker = document.querySelector('[data-testid="zone-theme-picker"]') as HTMLElement;
      expect(picker).toBeTruthy();
      // Wheel on the picker should not bubble to parent (canvas zoom prevention)
      fireEvent.wheel(picker);
      // Picker remains open after wheel — event was handled
      expect(document.querySelector('[data-testid="zone-theme-picker"]')).toBeTruthy();
    });

    it('stops mousedown from propagating through the portal', () => {
      const { getByTitle } = renderZoneCard();
      fireEvent.click(getByTitle('Zone theme'));

      const picker = document.querySelector('[data-testid="zone-theme-picker"]') as HTMLElement;
      expect(picker).toBeTruthy();

      // Mousedown on picker should not close it (canvas drag prevention)
      fireEvent.mouseDown(picker);
      expect(document.querySelector('[data-testid="zone-theme-picker"]')).toBeTruthy();
    });
  });

  describe('theme picker outside-click dismissal', () => {
    it('closes picker on mousedown outside both button and picker', () => {
      const { getByTitle } = renderZoneCard();
      fireEvent.click(getByTitle('Zone theme'));
      expect(document.querySelector('[data-testid="zone-theme-picker"]')).toBeTruthy();

      // Click outside — dispatched on window
      fireEvent.mouseDown(document.body);
      expect(document.querySelector('[data-testid="zone-theme-picker"]')).toBeNull();
    });

    it('keeps picker open when clicking inside it', () => {
      const { getByTitle } = renderZoneCard();
      fireEvent.click(getByTitle('Zone theme'));

      const picker = document.querySelector('[data-testid="zone-theme-picker"]') as HTMLElement;
      fireEvent.mouseDown(picker);
      expect(document.querySelector('[data-testid="zone-theme-picker"]')).toBeTruthy();
    });
  });

  describe('theme selection', () => {
    it('calls onThemeChange when a theme is selected', () => {
      const { getByTitle, onThemeChange } = renderZoneCard();
      fireEvent.click(getByTitle('Zone theme'));

      const picker = document.querySelector('[data-testid="zone-theme-picker"]') as HTMLElement;
      const buttons = picker.querySelectorAll('button');
      // Click the second theme (catppuccin-latte)
      fireEvent.click(buttons[1]);

      expect(onThemeChange).toHaveBeenCalledWith('catppuccin-latte');
    });

    it('closes picker after selection', () => {
      const { getByTitle } = renderZoneCard();
      fireEvent.click(getByTitle('Zone theme'));
      expect(document.querySelector('[data-testid="zone-theme-picker"]')).toBeTruthy();

      const picker = document.querySelector('[data-testid="zone-theme-picker"]') as HTMLElement;
      const buttons = picker.querySelectorAll('button');
      fireEvent.click(buttons[0]);

      expect(document.querySelector('[data-testid="zone-theme-picker"]')).toBeNull();
    });
  });
});
