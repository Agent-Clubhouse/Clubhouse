import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../../components/Button';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useChromeStore } from '../../chrome/chromeStore';
import { useWelcomeTourStore } from './welcomeTourStore';
import { STEP_NAMES, isLastPosition, stepScenes, tourSteps } from './tour-model';
import { playScene, prefersReducedMotion } from './scene-engine';
import { SCENES, type SceneDef } from './scenes';

/**
 * The 1.0 welcome tour (#2814), in the pane. It's never a modal: the sidebar
 * works around it, and opening anything there closes it, as opening anything
 * else closes the Dispatcher's view. Skip, Esc, Done and moving away all count
 * as seen. It comes back from Help and Settings › What's new.
 */

const STAGE_W = 740;
const STAGE_H = 300;

/**
 * How recent a person's own click or key press must be for a change of view to
 * count as theirs. Views change in the same moment as the input that changed
 * them; the window only covers a re-render or two.
 */
export const USER_NAVIGATION_WINDOW_MS = 1500;

/**
 * Close the tour once the person opens something else: a tab, project, agent,
 * host, the Dispatcher or New agent. A change nobody asked for (a plugin or an
 * orchestrator starting an agent in the background, say) only moves the
 * baseline, so the tour stays and isn't marked seen.
 */
function useCloseOnNavigation(): void {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activeHostId = useUIStore((s) => s.activeHostId);
  const dispatcherOpen = useUIStore((s) => s.dispatcherOpen);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const newAgent = useChromeStore((s) => s.newAgent);
  const base = useRef<string | null>(null);
  const lastInput = useRef(0);
  useEffect(() => {
    const mark = () => { lastInput.current = Date.now(); };
    document.addEventListener('pointerdown', mark, true);
    document.addEventListener('keydown', mark, true);
    return () => {
      document.removeEventListener('pointerdown', mark, true);
      document.removeEventListener('keydown', mark, true);
    };
  }, []);
  const now = [explorerTab, activeHostId, dispatcherOpen, activeProjectId, activeAgentId, !!newAgent].join('|');
  useEffect(() => {
    if (base.current === null || base.current === now) { base.current = now; return; }
    base.current = now;
    if (Date.now() - lastInput.current <= USER_NAVIGATION_WINDOW_MS) useWelcomeTourStore.getState().closeTour('navigate');
  }, [now]);
}

/** Scale the fixed-size picture down to fit a narrow pane. */
function useStageScale(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const width = el.clientWidth;
      if (width > 0) setScale(Math.min(1, (width - 2) / STAGE_W));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, scale];
}

function Stage({ def, sceneKey }: { def: SceneDef; sceneKey: string }) {
  const [frameRef, scale] = useStageScale();
  const rootRef = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(0);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !def.play) return undefined;
    return playScene(root, def.play, reduced);
  }, [def, sceneKey, run, reduced]);

  if (!def.Stage) return null;
  const Picture = def.Stage;
  if (def.tall) {
    return (
      <div className="wt-stage tall">
        <div ref={rootRef} key={`${sceneKey}:${run}`} className="wt-stage-in">
          <Picture />
        </div>
      </div>
    );
  }
  return (
    <div ref={frameRef} className="wt-stage" style={{ height: Math.round(STAGE_H * scale) + 2 }} aria-hidden="true">
      <div
        ref={rootRef}
        key={`${sceneKey}:${run}`}
        className="wt-stage-in"
        style={{ width: STAGE_W, height: STAGE_H, transform: scale < 1 ? `scale(${scale})` : undefined }}
      >
        <Picture />
      </div>
      {def.play && !reduced && (
        <button type="button" className="wt-replay focus-ring" onClick={() => setRun((n) => n + 1)} tabIndex={-1}>Replay</button>
      )}
    </div>
  );
}

export function WelcomeTour() {
  const variant = useWelcomeTourStore((s) => s.variant);
  const hasProjects = useWelcomeTourStore((s) => s.hasProjects);
  const smartRouting = useWelcomeTourStore((s) => s.smartRouting);
  const position = useWelcomeTourStore((s) => s.position);
  const { next, back, goToStep, goToScene, closeTour } = useWelcomeTourStore.getState();
  useCloseOnNavigation();

  const steps = tourSteps(variant, hasProjects);
  const step = steps[position.step];
  const scenes = stepScenes(step, variant, smartRouting);
  const scene = scenes[position.scene];
  const def = SCENES[scene];
  const title = typeof def.title === 'function' ? def.title(variant) : def.title;
  const last = isLastPosition({ variant, hasProjects, smartRouting }, position);
  const atStart = position.step === 0 && position.scene === 0;

  // Focus moves in when the tour opens and goes back where it was when it closes.
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    return () => { if (before && before.isConnected) before.focus(); };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') { e.preventDefault(); closeTour('skip'); return; }
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  };

  const primary = position.step === 0 ? 'Start the tour' : last ? 'Done' : 'Next';
  const Extra = def.Extra;

  return (
    <div
      ref={rootRef}
      data-testid="welcome-tour"
      data-variant={variant}
      data-step={step}
      data-scene={scene}
      role="region"
      aria-label="Welcome tour"
      className="wt h-full overflow-y-auto bg-ctp-base"
      onKeyDown={onKeyDown}
    >
      <div className="wt-col">
        <nav className="wt-prog" aria-label="Tour steps">
          {steps.map((s, i) => (
            <button
              key={s}
              type="button"
              data-testid={`welcome-tour-step-${s}`}
              aria-current={i === position.step ? 'step' : undefined}
              className={`focus-ring ${i === position.step ? 'on' : i < position.step ? 'done' : ''}`}
              onClick={() => goToStep(i)}
            >
              <i aria-hidden="true" />
              {STEP_NAMES[s]}
            </button>
          ))}
        </nav>

        <Stage def={def} sceneKey={scene} />

        <div className="wt-text" aria-live="polite">
          <h1 ref={headingRef} tabIndex={-1} className="wt-h" data-testid="welcome-tour-title">{title}</h1>
          {def.lead && <p className="wt-p wt-lead">{def.lead}</p>}
          <p className="wt-p">{def.text}</p>
          {Extra && <Extra />}
        </div>

        <div className="wt-foot">
          <Button kind="quiet" data-testid="welcome-tour-skip" className="focus-ring" onClick={() => closeTour('skip')}>Skip the tour</Button>
          <span className="wt-sp" />
          {scenes.length > 1 && (
            <div className="wt-pips">
              {scenes.map((k, i) => (
                <button
                  key={k}
                  type="button"
                  className={`wt-pip focus-ring ${i === position.scene ? 'on' : ''}`}
                  aria-label={`${typeof SCENES[k].title === 'function' ? STEP_NAMES[step] : SCENES[k].title}, ${i + 1} of ${scenes.length}`}
                  aria-current={i === position.scene ? 'true' : undefined}
                  onClick={() => goToScene(i)}
                />
              ))}
              <span className="wt-muted" aria-hidden="true">{position.scene + 1} of {scenes.length}</span>
            </div>
          )}
          <span className="wt-sp" />
          {!atStart && <Button data-testid="welcome-tour-back" className="focus-ring" onClick={back}>Back</Button>}
          <Button kind="primary" data-testid="welcome-tour-next" className="focus-ring" onClick={next}>{primary}</Button>
        </div>
      </div>
    </div>
  );
}
