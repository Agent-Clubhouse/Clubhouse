import { Button } from '../../../components/Button';
import { curve } from '../scene-engine';
import { AgentNode, Av, Ov, TourLink, Wire, pos } from '../stage-parts';
import { openDispatcherSetupFromTour, openHelpLink } from '../tour-actions';
import type { SceneDef } from './types';

/**
 * The Dispatcher: one request played out across projects. Its button opens
 * the Dispatcher's own setup (#3047), which still owns the first real
 * conversation. Opening it wakes nothing and spends no tokens; that waits
 * until you send something. The agents and replies are examples.
 */

const ROWS: Array<[n: string, ch: string, name: string, status: string, y: number]> = [
  ['dr', 'R', 'reviewer', 'Working', 40],
  ['da', 'A', 'api-builder', 'Idle', 78],
  ['dw', 'W', 'docs-writer', 'Sleeping', 164],
];
const IDLE_PROMPT = 'Message the Dispatcher';

function DispatcherStage() {
  return (
    <>
      <Ov>
        {ROWS.map(([n, , , , y]) => <Wire key={n} n={`x${n}`} d={curve(340, 130, 434, y + 15)} cls="faint" />)}
      </Ov>
      <div className="fp rv n-panel panel" style={pos(20, 10, 320, { height: 280 })}>
        <div className="fp-h"><Av ch="D" /><b>Dispatcher</b><span className="sp" /><span className="wt-muted n-dst">Idle</span></div>
        <div className="chat">
          <div className="msgx n-m1"><div className="bb me">Catch me up on storefront</div></div>
          <div className="msgx n-dots"><div className="dots"><i /><i /><i /></div></div>
          <div className="msgx n-m2"><div className="bb d">reviewer finished the cart fix and opened a pull request. api-builder is waiting for you to approve a migration.</div></div>
          <div className="msgx n-m3"><div className="bb me">Every weekday at 9, tell me what changed overnight</div></div>
          <div className="msgx n-m4">
            <div className="sched">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--wt-accent)" strokeWidth="1.3" />
                <path d="M8 4.5 V8 L10.5 9.5" stroke="var(--wt-accent)" strokeWidth="1.3" fill="none" strokeLinecap="round" />
              </svg>
              <span><b>Weekdays at 9:00</b><br /><span className="wt-muted">Post what changed overnight</span></span>
            </div>
          </div>
        </div>
        <div className="compo n-compo">{IDLE_PROMPT}</div>
      </div>
      <div className="box" style={pos(420, 10, 308, { height: 110 })}><span className="bl">storefront</span></div>
      <div className="box" style={pos(420, 132, 308, { height: 72 })}><span className="bl">api</span></div>
      <div className="box dash" style={pos(420, 216, 308, { height: 60 })}>
        <span className="bl">mobile-app</span>
        <span className="wt-muted boxnote">Not connected to the Dispatcher, so it can&rsquo;t reach these agents.</span>
      </div>
      {ROWS.map(([n, ch, name, status, y]) => <AgentNode key={n} n={n} x={434} y={y} w={280} ch={ch} name={name} status={status} />)}
    </>
  );
}

function DispatcherExtra() {
  return (
    <div className="wt-x">
      <Button onClick={openDispatcherSetupFromTour}>Set it up now</Button>
      <span className="wt-muted">Pick its name, look and personality.</span>
      <TourLink onClick={() => openHelpLink('dispatcher')}>The Dispatcher, in Help</TourLink>
    </div>
  );
}

export const dispatcher: SceneDef = {
  title: 'Meet the Dispatcher',
  text: 'Tell it what you want in plain words. It keeps track of what your agents are doing, gets work going across your projects, sets things up to happen on a schedule, and remembers what you decide. It only reaches agents you connect to it.',
  Extra: DispatcherExtra,
  Stage: DispatcherStage,
  play: (c) => {
    c.on(0, '.n-panel, .n-dr, .n-da, .n-dw');
    c.on(300, '.n-compo', 'typing');
    c.type(300, '.n-compo', 'Catch me up on storefront', 40);
    c.at(1450, () => {
      const e = c.q('.n-compo');
      if (e) { e.textContent = IDLE_PROMPT; e.classList.remove('typing'); }
      c.q('.n-m1')?.classList.add('in');
      const s = c.q('.n-dst');
      if (s) s.textContent = 'Working';
    });
    ROWS.slice(0, 2).forEach(([n, , , , y], i) => {
      c.on(1800, `.n-x${n}`, 'hot');
      c.on(1800, `.n-${n}`, 'lit');
      c.pulse(1800 + i * 100, curve(340, 130, 434, y + 15), 'var(--wt-mauve)', 600);
      c.pulse(2700 + i * 120, curve(434, y + 15, 340, 130), 'var(--wt-green)', 600);
    });
    c.status(2500, '.n-dr', 'Pull request open', 'ok');
    c.status(2650, '.n-da', 'Needs your OK', 'warn');
    c.on(3000, '.n-dots');
    c.at(3700, () => {
      c.q('.n-dots')?.classList.remove('in');
      c.q('.n-m2')?.classList.add('in');
      const s = c.q('.n-dst');
      if (s) s.textContent = 'Idle';
      c.qa('.an.lit').forEach((e) => e.classList.remove('lit'));
      c.qa('.w.hot').forEach((e) => e.classList.remove('hot'));
    });
    c.on(4700, '.n-compo', 'typing');
    c.type(4700, '.n-compo', 'Every weekday at 9, tell me what changed overnight', 28);
    c.at(6250, () => {
      const e = c.q('.n-compo');
      if (e) { e.textContent = IDLE_PROMPT; e.classList.remove('typing'); }
      c.q('.n-m3')?.classList.add('in');
    });
    c.on(7000, '.n-m4');
  },
};
