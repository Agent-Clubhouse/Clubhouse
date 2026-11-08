/**
 * Which layout an E2E launch uses (#2843). See e2e/classic-specs.mjs.
 */
import type { Page } from '@playwright/test';
import { CLASSIC_LAYOUT_ENV } from './classic-specs.mjs';

/** True in the Classic layout E2E job, where launches default to classic. */
export const isClassicRun = process.env[CLASSIC_LAYOUT_ENV] === 'classic';

/**
 * The flags a launch seeds: in the classic run, `newChrome: false` unless the
 * spec chose a layout itself.
 */
export function withRunLayout(experimental: Record<string, boolean> | undefined): Record<string, boolean> | undefined {
  if (!isClassicRun || experimental?.newChrome !== undefined) return experimental;
  return { ...experimental, newChrome: false };
}

/**
 * The flags to seed for the classic run when the spec passed none, given what
 * a reused profile already saved: the saved flags plus `newChrome: false`.
 * Returns undefined to leave the file alone: when it's unreadable (which
 * starts classic anyway, and is what some specs test) or already names a
 * layout.
 */
export function classicRunSeedOver(savedText: string | undefined): Record<string, boolean> | undefined {
  if (savedText === undefined) return { newChrome: false };
  let saved: unknown;
  try { saved = JSON.parse(savedText); } catch { return undefined; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return undefined;
  if ((saved as Record<string, unknown>).newChrome !== undefined) return undefined;
  return { ...(saved as Record<string, boolean>), newChrome: false };
}

const layoutByPage = new WeakMap<Page, boolean>();

/**
 * Whether this window shows the new layout, read from the app. Helpers go by
 * this rather than the job, because specs still pinned to classic run in
 * every job.
 */
export async function isNewLayout(window: Page): Promise<boolean> {
  const known = layoutByPage.get(window);
  if (known !== undefined) return known;
  const value = await window.evaluate(() => (globalThis as { clubhouse?: { newChromeLayout?: boolean } }).clubhouse?.newChromeLayout === true);
  layoutByPage.set(window, value);
  return value;
}
