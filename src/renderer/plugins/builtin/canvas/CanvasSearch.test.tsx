import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { CanvasSearch } from './CanvasSearch';

const LABELS: Record<string, string> = { darwin: 'Search views (⌘F)', win32: 'Search views (Ctrl+F)', linux: 'Search views (Ctrl+F)' };

describe('CanvasSearch shortcut label', () => {
  for (const platform of Object.keys(LABELS)) {
    describe(platform, () => {
      beforeEach(() => {
        (window as unknown as { clubhouse: Record<string, unknown> }).clubhouse = {
          ...((window as unknown as { clubhouse?: Record<string, unknown> }).clubhouse ?? {}),
          platform,
        };
      });
      it('uses the platform modifier', () => {
        render(<CanvasSearch views={[]} onSelectView={() => {}} />);
        expect(screen.getByTestId('canvas-search-toggle').getAttribute('aria-label')).toBe(LABELS[platform]);
      });
    });
  }
});
