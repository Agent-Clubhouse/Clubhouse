/* eslint-disable no-restricted-syntax -- reads index.css and component sources: the gradient rule is plain CSS that jsdom never applies, so the test checks its selector directly */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { render, screen } from '@testing-library/react';
import { Modal } from './components/Modal';
import { PopupMenu } from './components/PopupMenu';

/**
 * Regression test for #2095: with a gradient theme, `index.css` makes
 * bg-ctp-base/mantle/crust transparent so the body gradient shows through
 * layout wrappers. Floating surfaces (canvas cards, popovers, tooltips,
 * dialogs, menus) must keep their solid color, or whatever is behind them
 * shows through (overlapping canvas cards rendered both cards' text).
 *
 * jsdom doesn't apply the stylesheet, so these tests pull the transparent
 * rule's selector out of index.css and check which elements it matches.
 */

const css = fs.readFileSync(path.resolve(__dirname, 'index.css'), 'utf-8');

function transparentSelector(): string {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const rule = rules.find(([, selector, body]) =>
    selector.includes('.theme-gradient-bg') && /background-color:\s*transparent\s*!important/.test(body),
  );
  if (!rule) throw new Error('gradient transparency rule not found in index.css');
  return rule[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SELECTOR = transparentSelector();
const SOLID_BG = /(?:^|\s)bg-ctp-(?:base|mantle|crust)(?=\s|$)/;
// Traits that mean an element sits on top of other content.
const FLOATING = /(?:^|\s)(?:fixed|absolute|sticky|z-\S+|shadow-\S+)(?=\s|$)/;

function el(className: string, attrs: Record<string, string> = {}): HTMLElement {
  const node = document.createElement('div');
  node.className = className;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  document.body.appendChild(node);
  return node;
}

function isTransparent(node: Element): boolean {
  return node.matches(SELECTOR);
}

/** Every string or template literal in renderer .tsx sources that sets a solid base/mantle/crust background. */
function solidBgClassStrings(): { file: string; classes: string }[] {
  const root = __dirname;
  const out: { file: string; classes: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) continue;
      const src = fs.readFileSync(full, 'utf-8');
      for (const [, , body] of src.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.)*?)\1/g)) {
        const classes = body.replace(/\$\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
        if (SOLID_BG.test(classes)) out.push({ file: path.relative(root, full), classes });
      }
    }
  };
  walk(root);
  return out;
}

describe('gradient theme surfaces (#2095)', () => {
  beforeAll(() => { document.documentElement.classList.add('theme-gradient-bg'); });
  afterAll(() => { document.documentElement.classList.remove('theme-gradient-bg'); });

  it('still makes layout wrappers transparent so the gradient shows', () => {
    // App root, chrome sidebar and title bar
    expect(isTransparent(el('h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col'))).toBe(true);
    expect(isTransparent(el('h-full min-h-0 flex flex-col bg-ctp-mantle border-r border-surface-0 overflow-hidden'))).toBe(true);
    expect(isTransparent(el('h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0'))).toBe(true);
  });

  it('does nothing without the gradient class', () => {
    document.documentElement.classList.remove('theme-gradient-bg');
    try {
      expect(isTransparent(el('h-full bg-ctp-base'))).toBe(false);
    } finally {
      document.documentElement.classList.add('theme-gradient-bg');
    }
  });

  it('keeps the shared Modal panel solid (feedback dialog)', () => {
    render(<Modal open onClose={() => {}} title="Send feedback" testId="modal" footer={<span>footer</span>}>body</Modal>);
    const dialog = screen.getByRole('dialog');
    const panel = dialog.matches('.bg-ctp-base') ? dialog : dialog.querySelector('.bg-ctp-base');
    expect(panel).not.toBeNull();
    expect(isTransparent(panel!)).toBe(false);
  });

  it('keeps the shared PopupMenu solid', () => {
    render(<PopupMenu items={[{ id: 'a', label: 'A', onSelect: () => {} }]} position={{ x: 0, y: 0 }} label="Menu" onClose={() => {}} />);
    expect(isTransparent(screen.getByRole('menu'))).toBe(false);
  });

  it('keeps the reported surfaces solid: canvas cards, sidebar hover card, tooltip', () => {
    const sources = solidBgClassStrings();
    const find = (file: string) => sources.filter((s) => s.file === file);
    for (const file of [
      path.join('plugins', 'builtin', 'canvas', 'CanvasView.tsx'),
      path.join('chrome', 'sidebar', 'AgentHoverCard.tsx'),
      path.join('components', 'Tooltip.tsx'),
    ]) {
      const floating = find(file).filter((s) => FLOATING.test(s.classes));
      expect(floating.length, `${file} has no floating solid surface`).toBeGreaterThan(0);
      for (const s of floating) expect(isTransparent(el(s.classes)), `${file}: "${s.classes}"`).toBe(false);
    }
  });

  it('never makes a positioned, layered or shadowed solid surface transparent', () => {
    const offenders = solidBgClassStrings()
      .filter((s) => FLOATING.test(s.classes))
      .filter((s) => isTransparent(el(s.classes)))
      .map((s) => `${s.file}: "${s.classes}"`);
    expect(offenders).toEqual([]);
  });

  it('keeps popup roles and the .surface-opaque escape hatch solid', () => {
    for (const role of ['dialog', 'alertdialog', 'menu', 'listbox', 'tooltip']) {
      expect(isTransparent(el('bg-ctp-mantle', { role })), role).toBe(false);
    }
    expect(isTransparent(el('bg-ctp-base surface-opaque'))).toBe(false);
  });
});
