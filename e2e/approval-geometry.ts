import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ElectronApp } from './launch';

/**
 * Where an approval's Allow button sits as requests come and go (#3606).
 * A probe, not a layout spec: each surface records the button's bounding box
 * for every request in a queue, at three window sizes, prints the table and
 * fails only when the button's y moves more than a few pixels between the
 * requests of one size. CI says which surfaces move; nothing here fixes one.
 */

export interface WindowSize {
  label: string;
  /** Content size; undefined keeps the size the app opened at. */
  width?: number;
  height?: number;
}

/** The size the app opens at, then a short laptop split, then a narrow pane. */
export const WINDOW_SIZES: WindowSize[] = [
  { label: 'default' },
  { label: '820x520', width: 820, height: 520 },
  { label: '640x520', width: 640, height: 520 },
];

/** Pixels the button may move between two requests before the probe fails. */
export const MOVE_TOLERANCE_PX = 3;

export interface Box { x: number; y: number; width: number; height: number }

export interface Sample {
  surface: string;
  size: string;
  /** The window's content size when it was measured. */
  inner: string;
  /** 1-based position in the queue. */
  request: number;
  box: Box;
  /** What else moved with it: the scrolling region's offset, the card's own top, anything the surface adds. */
  notes: Record<string, number | string | boolean>;
}

/** Resize the window's content area, or restore `original` for the default size. Waits on the renderer's own size. */
export async function setWindowSize(app: ElectronApp, page: Page, size: WindowSize, original: { width: number; height: number }): Promise<void> {
  const width = size.width ?? original.width;
  const height = size.height ?? original.height;
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setMinimumSize(320, 320);
    win?.setContentSize(w, h);
  }, [width, height]);
  // A window manager may round a pixel or two; a size it refuses shows in the table's `inner` column.
  await expect.poll(() => page.evaluate(([w, h]) => Math.max(Math.abs(window.innerWidth - w), Math.abs(window.innerHeight - h)), [width, height])).toBeLessThanOrEqual(2);
}

/** The window's size when the app opened it. */
export async function originalSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

/** The box once it has stopped moving: the same two reads in a row, so an entry animation or a reflow has finished. */
export async function settledBox(locator: Locator): Promise<Box> {
  const read = () => locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
  });
  let last = JSON.stringify(await read());
  await expect.poll(async () => {
    const now = JSON.stringify(await read());
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [100, 100, 200, 300], timeout: 10_000 }).toBe(true);
  return JSON.parse(last) as Box;
}

/** Collects samples, prints them, and judges them. */
export class GeometryLog {
  readonly samples: Sample[] = [];
  constructor(private readonly surface: string) {}

  async record(page: Page, size: WindowSize, request: number, allow: Locator, notes: Sample['notes'] = {}): Promise<Sample> {
    const box = await settledBox(allow);
    const inner = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
    const sample: Sample = { surface: this.surface, size: size.label, inner, request, box, notes };
    this.samples.push(sample);
    return sample;
  }

  /** How far y moved across the requests of each size, largest first. */
  moves(): Array<{ size: string; spread: number; ys: number[] }> {
    const sizes = [...new Set(this.samples.map((s) => s.size))];
    return sizes.map((size) => {
      const ys = this.samples.filter((s) => s.size === size).map((s) => s.box.y);
      return { size, spread: ys.length ? Math.max(...ys) - Math.min(...ys) : 0, ys };
    }).sort((a, b) => b.spread - a.spread);
  }

  table(): string {
    const lines = this.samples.map((s) => `${s.surface} | ${s.size} (${s.inner}) | request ${s.request} | allow x=${s.box.x} y=${s.box.y} w=${s.box.width} h=${s.box.height} | ${JSON.stringify(s.notes)}`);
    const moves = this.moves().map((m) => `${this.surface} | ${m.size}: y ${m.ys.join(', ')} (spread ${m.spread.toFixed(1)}px)`);
    return [...lines, '--', ...moves].join('\n');
  }

  /** Print and attach the table, then fail if any size's y moved more than the tolerance. */
  async assertStable(): Promise<void> {
    const table = this.table();
    console.log(`\n[approval-geometry] ${this.surface}\n${table}\n`);
    const worst = this.moves()[0];
    const info = test.info();
    info.annotations.push({ type: 'approval-geometry', description: `${this.surface}: worst y spread ${worst ? worst.spread.toFixed(1) : 0}px at ${worst?.size ?? 'n/a'}` });
    await info.attach(`approval-geometry-${this.surface}.txt`, { body: table, contentType: 'text/plain' });
    await info.attach(`approval-geometry-${this.surface}.json`, { body: JSON.stringify(this.samples, null, 2), contentType: 'application/json' });
    expect(this.samples.length, 'the probe measured nothing').toBeGreaterThan(0);
    for (const m of this.moves()) {
      expect(m.spread, `${this.surface} at ${m.size}: Allow's y across requests was ${m.ys.join(', ')}`).toBeLessThanOrEqual(MOVE_TOLERANCE_PX);
    }
  }
}
