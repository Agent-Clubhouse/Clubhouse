import { Button } from '../../../components/Button';
import { useWelcomeTourStore } from '../welcomeTourStore';
import { AgentNode, Av, Ov, TourLink, Wire, pos } from '../stage-parts';
import { openHelpLink, openNewAgentFromTour } from '../tour-actions';
import type { SceneDef } from './types';

/**
 * Orchestrators and helpers, for everyone. It follows the built-in
 * Orchestrator and Helper text: helpers start with start_helper, report with
 * message_parent, a QA helper reviews before a pull request, and deleting a
 * helper removes its workspace. Smart routing is a second scene only when it
 * has CLIs to choose between (smart-routing-gate.ts).
 */

/** [key, helper name, task, difficulty, top]; each row's centre is top + 16. */
const ROWS: Array<[k: string, helper: string, task: string, difficulty: string, y: number]> = [
  ['0', 'rate-limiter', 'Rate limiter middleware', 'medium', 86],
  ['1', 'config-docs', 'Config keys and docs', 'easy', 128],
  ['2', 'load-test', 'Load test', 'medium', 170],
  ['3', 'review', 'Review the changes', 'QA helper', 212],
];

function OrchStage() {
  return (
    <>
      <Ov>
        <Wire n="g" d="M28 70 L28 186" />
        <Wire n="g2" d="M28 186 L28 228" />
        {ROWS.map(([k, , , , y]) => (
          <g key={k}>
            <Wire n={`k${k}`} d={`M28 ${y + 16} L44 ${y + 16}`} />
            <Wire n={`w${k}`} d={`M440 ${y + 16} L260 ${y + 16}`} />
          </g>
        ))}
      </Ov>
      <div className="lab" style={pos(16, 16)}>Sidebar</div>
      <div className="lab" style={pos(440, 16)}>The plan</div>
      <AgentNode n="orch" x={16} y={38} w={244} ch="O" name="planner" status="Planning" />
      <div className="pc rv n-goal" style={pos(440, 39, 284)}><b>Add rate limiting to the API</b><span className="sub">From you</span></div>
      {ROWS.map(([k, helper, task, difficulty, y]) => (
        <div key={k}>
          <div className={`an rv n-h${k}`} style={pos(44, y, 216)}><Av ch="H" /><span>{helper}</span><span className="st">Working</span></div>
          <div className={`pc sm rv n-t${k}`} style={pos(440, y + 1, 284)}><span className="ord">{+k + 1}</span><b>{task}</b><span className="sub">{difficulty}</span></div>
        </div>
      ))}
      <div className="awhy n-why" style={pos(16, 266, 600)} />
    </>
  );
}

function OrchExtra() {
  const hasProjects = useWelcomeTourStore((s) => s.hasProjects);
  return (
    <div className="wt-x">
      {hasProjects && <Button onClick={openNewAgentFromTour}>Create an orchestrator</Button>}
      <span className="wt-muted">Start from the Orchestrator template, or turn on helpers for any agent and set its helper limit.</span>
      <TourLink onClick={() => openHelpLink('helpers')}>Orchestrators and helpers, in Help</TourLink>
    </div>
  );
}

export const orch: SceneDef = {
  title: 'Orchestrators split the work across helpers',
  text: 'An orchestrator is an agent that plans a job and starts helpers to do it. A helper is a short-lived agent for one task, in its own workspace on its own branch. It reports back to the orchestrator, which checks the work and deletes the helper once it’s accepted.',
  Extra: OrchExtra,
  Stage: OrchStage,
  play: (c) => {
    const start = (ms: number, k: string, y: number) => {
      c.on(ms, `.n-w${k}`);
      c.on(ms, `.n-w${k}`, 'hot');
      c.pulse(ms, `M440 ${y + 16} L260 ${y + 16}`, 'var(--wt-accent)', 450);
      c.on(ms + 350, `.n-h${k}, .n-k${k}`);
    };
    c.on(0, '.n-orch, .n-goal');
    c.caption(100, '.n-why', 'Give an orchestrator a bigger job. It reads the code and splits the work into tasks.');
    [0, 1, 2].forEach((i) => c.on(700 + i * 300, `.n-t${i}`));
    c.status(2000, '.n-orch', 'Starting helpers');
    c.on(2100, '.n-g');
    [0, 1, 2].forEach((i) => start(2200 + i * 350, ROWS[i][0], ROWS[i][4]));
    c.caption(2300, '.n-why', 'It starts a helper per task. Each one sits under it in the sidebar, on its own branch.');
    c.off(3600, '.n-w0, .n-w1, .n-w2', 'hot');
    c.on(3600, '.n-w0, .n-w1, .n-w2', 'faint');
    c.status(3600, '.n-orch', 'Waiting on helpers');
    c.status(4200, '.n-h1', 'Asking', 'warn');
    c.on(4200, '.n-h1, .n-orch', 'lit');
    c.caption(4300, '.n-why', 'Helpers report to the orchestrator, not to you. It passes on only what’s yours to decide.');
    c.off(5200, '.n-h1, .n-orch', 'lit');
    c.status(5200, '.n-h1', 'Working');
    [0, 1, 2].forEach((i) => c.status(5600 + i * 300, `.n-h${i}`, 'Pushed', 'ok'));
    c.on(6500, '.n-t3, .n-g2');
    start(6700, ROWS[3][0], ROWS[3][4]);
    c.status(6500, '.n-orch', 'Reviewing');
    c.caption(6600, '.n-why', 'Before anything becomes a pull request, a QA helper reviews it.');
    c.status(7800, '.n-h3', 'Approved', 'ok');
    ROWS.forEach(([k], i) => {
      const t = 8400 + i * 180;
      c.on(t, `.n-t${k}`, 'done');
      c.at(t, () => { const sub = c.q(`.n-t${k} .sub`); if (sub) sub.textContent = 'Accepted'; });
      c.off(t, `.n-h${k}`, 'in');
      c.on(t, `.n-k${k}, .n-w${k}`, 'gone');
    });
    c.on(8400, '.n-g, .n-g2', 'gone');
    c.caption(8500, '.n-why', 'Then it deletes its helpers and tells you what landed.');
    c.status(9000, '.n-orch', 'Pull request open', 'ok');
  },
};
