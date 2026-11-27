/**
 * The tour's scene player, ported from the 1.0 comps' prototype. A scene's
 * stage is static markup; its `play` schedules class changes on that markup
 * (`in`, `lit`, `hot`, `done` …) and the CSS does the moving. With reduced
 * motion every step runs at once, so the stage shows its final state and
 * nothing moves.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // telemetry-exempt: no media query means no preference, so the scenes move.
    return false;
  }
}

export interface SceneContext {
  readonly reduced: boolean;
  q: (selector: string) => HTMLElement | null;
  qa: (selector: string) => HTMLElement[];
  /** Run `fn` after `ms` (at once with reduced motion). */
  at: (ms: number, fn: () => void) => void;
  /** Add `cls` (default `in`) to every match after `ms`. */
  on: (ms: number, selector: string, cls?: string) => void;
  /** Remove `cls` from every match after `ms`. */
  off: (ms: number, selector: string, cls: string) => void;
  /** Set the status text (and tone) of `.st` inside the match after `ms`. */
  status: (ms: number, selector: string, text: string, tone?: 'ok' | 'warn') => void;
  /** Send a dot along an SVG path in the stage's overlay. Nothing with reduced motion. */
  pulse: (ms: number, d: string, color: string, dur?: number) => void;
  /** Type `text` into the match, a character every `step` ms. */
  type: (ms: number, selector: string, text: string, step?: number) => void;
  /** Swap the text of the match, fading it out and in. */
  caption: (ms: number, selector: string, text: string) => void;
}

export type ScenePlay = (c: SceneContext) => void;

/** Start a scene on `root`. Returns a stop function that cancels everything still pending. */
export function playScene(root: HTMLElement, play: ScenePlay, reduced = prefersReducedMotion()): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  const later = (ms: number, fn: () => void) => {
    timers.push(setTimeout(() => { if (!stopped) fn(); }, reduced ? 0 : ms));
  };
  const qa = (selector: string) => Array.from(root.querySelectorAll<HTMLElement>(selector));
  const c: SceneContext = {
    reduced,
    q: (selector) => root.querySelector<HTMLElement>(selector),
    qa,
    at: later,
    on: (ms, selector, cls = 'in') => later(ms, () => qa(selector).forEach((e) => e.classList.add(cls))),
    off: (ms, selector, cls) => later(ms, () => qa(selector).forEach((e) => e.classList.remove(cls))),
    status: (ms, selector, text, tone) => later(ms, () => {
      for (const e of qa(`${selector} .st`)) {
        e.textContent = text;
        e.classList.toggle('ok', tone === 'ok');
        e.classList.toggle('warn', tone === 'warn');
      }
    }),
    pulse: (ms, d, color, dur = 700) => {
      if (reduced) return;
      later(ms, () => {
        const svg = root.querySelector('svg.ov');
        if (!svg) return;
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('r', '3.5');
        dot.setAttribute('fill', color);
        const motion = document.createElementNS(SVG_NS, 'animateMotion') as SVGAnimationElement;
        motion.setAttribute('dur', `${dur}ms`);
        motion.setAttribute('path', d);
        motion.setAttribute('fill', 'freeze');
        motion.setAttribute('begin', 'indefinite');
        dot.appendChild(motion);
        svg.appendChild(dot);
        try { motion.beginElement(); } catch {
          // telemetry-exempt: no SMIL here, so the dot is just left out.
          dot.remove();
          return;
        }
        timers.push(setTimeout(() => dot.remove(), dur + 60));
      });
    },
    type: (ms, selector, text, step = 40) => {
      if (reduced) { later(0, () => { const e = root.querySelector(selector); if (e) e.textContent = text; }); return; }
      for (let i = 1; i <= text.length; i++) {
        later(ms + i * step, () => { const e = root.querySelector(selector); if (e) e.textContent = text.slice(0, i); });
      }
    },
    caption: (ms, selector, text) => later(ms, () => {
      const e = root.querySelector<HTMLElement>(selector);
      if (!e) return;
      if (reduced) { e.textContent = text; return; }
      e.style.opacity = '0';
      timers.push(setTimeout(() => { if (stopped) return; e.textContent = text; e.style.opacity = '1'; }, 200));
    }),
  };
  try {
    play(c);
  } catch {
    // telemetry-exempt: a scene that can't play still shows its static markup.
  }
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
  };
}

/** A cubic from (x1, y1) to (x2, y2) that leaves and arrives level, as the comps draw connections. */
export function curve(x1: number, y1: number, x2: number, y2: number): string {
  const m = (x1 + x2) / 2;
  return `M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}`;
}
