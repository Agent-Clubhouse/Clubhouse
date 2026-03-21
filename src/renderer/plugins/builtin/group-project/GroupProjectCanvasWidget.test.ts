import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, 'GroupProjectCanvasWidget.tsx'), 'utf-8');

// ── Polling icon ────────────────────────────────────────────────────

describe('GroupProjectCanvasWidget — PollingIcon', () => {
  it('uses an activity/heartbeat SVG instead of circular sync arrows', () => {
    // The old icon used circular arrow paths (M21.5 2v6h-6 / M2.5 22v-6h6)
    // which looked like a refresh/sync icon. Verify those are gone.
    expect(source).not.toContain('M21.5 2v6h-6');
    expect(source).not.toContain('M2.5 22v-6h6');
  });

  it('renders a heartbeat polyline when active', () => {
    // Active state should show an activity/heartbeat wave
    expect(source).toContain('polyline points="22 12 18 12 15 21 9 3 6 12 2 12"');
  });

  it('renders a flat line when inactive', () => {
    // Inactive state should show a straight horizontal line
    expect(source).toMatch(/x1="2".*y1="12".*x2="22".*y2="12"/);
  });
});

// ── Polling toggle label ────────────────────────────────────────────

describe('GroupProjectCanvasWidget — polling toggle has label', () => {
  it('renders a "Poll" text label next to the icon', () => {
    // Both compact and expanded views should show a label next to the polling icon
    expect(source).toContain("'Poll'");
    // The label is inside a span sibling to PollingIcon
    expect(source).toMatch(/PollingIcon[\s\S]*?font-medium[\s\S]*?Poll/);
  });
});

// ── Activity dot ────────────────────────────────────────────────────

describe('GroupProjectCanvasWidget — activity dot', () => {
  it('does not use animate-pulse which looks like sync', () => {
    // The activity dot should NOT use animate-pulse as it was confusing
    expect(source).not.toContain('animate-pulse');
  });

  it('still uses green color for active status', () => {
    expect(source).toContain('bg-ctp-green');
  });
});

// ── generateDisplayName in plugin main ──────────────────────────────

describe('GroupProjectCanvasWidget — main.ts generateDisplayName', () => {
  const mainSource = readFileSync(join(__dirname, 'main.ts'), 'utf-8');

  it('provides a generateDisplayName callback', () => {
    expect(mainSource).toContain('generateDisplayName');
  });

  it('returns the project name from metadata when available', () => {
    // The callback should check metadata.name
    expect(mainSource).toContain('metadata.name');
  });
});
