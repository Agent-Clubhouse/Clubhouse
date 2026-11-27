import { Button } from '../../../components/Button';
import { providerDescriptor } from '../../../../shared/providers/descriptors';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { curve, type SceneContext } from '../scene-engine';
import { AgentStack, Av, Ov, TourLink, Wire, pos } from '../stage-parts';
import { openHelpLink, openSmartRoutingSettings } from '../tour-actions';
import type { SceneDef } from './types';

/**
 * Smart routing, shown only when it has CLIs to choose between
 * (smart-routing-gate.ts). Four columns, left to right: the orchestrator's
 * request, its difficulty, the CLIs and their plans, the helpers. The models
 * are the built-in presets for each difficulty. With Copilot as the second
 * CLI, its plan shows as unknown and it comes last, as Smart routing ranks it.
 */

type Second = 'codex-cli' | 'copilot-cli';

const DIFFS: Array<[k: 'e' | 'm' | 'h', label: string, y: number]> = [['e', 'Easy', 50], ['m', 'Medium', 100], ['h', 'Hard', 150]];
const D = { e: 50 + 17, m: 100 + 17, h: 150 + 17 };
/** The two CLI cards: Claude Code on top, the second below. Centres at top + 38. */
const V = { a: 46 + 38, b: 136 + 38 };

/** "Haiku, low", from a CLI's built-in preset for a difficulty. */
function preset(id: string, difficulty: 'easy' | 'hard'): string {
  const cell = providerDescriptor(id)?.helperRouting.presets?.[difficulty];
  if (!cell) return '';
  // Claude Code's short names read as words; the others are ids, kept as they are.
  const model = cell.model.includes('-') ? cell.model : cell.model.charAt(0).toUpperCase() + cell.model.slice(1);
  return `${model}, ${cell.effort ?? 'default'}`;
}

function name(id: string): string {
  return providerDescriptor(id)?.shortName ?? id;
}

/** Codex when it's ready, otherwise Copilot: the gate only shows this scene with one of them beside Claude Code, or both. */
function useSecond(): Second {
  const availability = useOrchestratorStore((s) => s.availability);
  const enabled = useOrchestratorStore((s) => s.enabled);
  return availability['codex-cli']?.available === true && enabled.includes('codex-cli') ? 'codex-cli' : 'copilot-cli';
}

/** The story each pair tells: who takes the easy job, who then nears its limit, who takes the hard one. */
function story(second: Second) {
  return second === 'codex-cli'
    ? { first: 'b' as const, then: 'a' as const, firstId: 'codex-cli', thenId: 'claude-code' }
    : { first: 'a' as const, then: 'b' as const, firstId: 'claude-code', thenId: 'copilot-cli' };
}

function SmartRoutingStage() {
  const second = useSecond();
  const s = story(second);
  const easyY = s.first === 'a' ? 62 : 152;
  const hardY = s.then === 'a' ? 62 : 152;
  return (
    <div data-second={second} className="n-root">
      <Ov>
        <Wire n="rq-e" d={curve(166, 142, 196, D.e)} />
        <Wire n="rq-h" d={curve(166, 142, 196, D.h)} />
        <Wire n="e-a" d={curve(296, D.e, 330, V.a)} />
        <Wire n="e-b" d={curve(296, D.e, 330, V.b)} />
        <Wire n={`h-${s.then}`} d={curve(296, D.h, 330, V[s.then])} />
        <Wire n="a-hp" d={`M500 ${V.a} L534 ${V.a}`} />
        <Wire n="b-hp" d={`M500 ${V.b} L534 ${V.b}`} />
      </Ov>
      {([['Orchestrator', 16], ['Difficulty', 196], ['CLI and plan', 330], ['Helpers', 534]] as const).map(([label, x]) => (
        <div key={label} className="lab" style={pos(x, 16)}>{label}</div>
      ))}
      <AgentStack n="orch" x={16} y={46} w={150} ch="O" name="planner" status="Orchestrator" />
      <div className="pc rv newc n-req" style={pos(16, 120, 150, { minHeight: 44 })} />
      {DIFFS.map(([k, label, y]) => <div key={k} className={`dp rv n-d${k}`} style={pos(196, y, 100)}>{label}</div>)}
      <div className="prov rv n-pa" style={pos(330, 46, 170)}>
        <b>{name('claude-code')}</b>
        <span className="pbar"><i className="n-paf" style={{ width: '64%' }} /></span>
        <span className="wt-muted n-pat">64% of plan used</span>
        <span className="pm n-pam">&nbsp;</span>
      </div>
      <div className="prov rv n-pb" style={pos(330, 136, 170)}>
        <b>{name(second)}</b>
        {second === 'codex-cli' ? (
          <>
            <span className="pbar"><i className="n-pbf" style={{ width: '38%' }} /></span>
            <span className="wt-muted n-pbt">38% of plan used</span>
          </>
        ) : (
          <span className="wt-muted n-pbt">Plan unknown, so it comes last</span>
        )}
        <span className="pm n-pbm">&nbsp;</span>
      </div>
      <div className="an rv n-hp-first" style={pos(534, easyY, 194)}>
        <Av ch="H" />
        <span className="an2"><span>Rename config keys</span><span className="st">{name(s.firstId)}, {preset(s.firstId, 'easy')}</span></span>
      </div>
      <div className="an rv n-hp-then" style={pos(534, hardY, 194)}>
        <Av ch="H" />
        <span className="an2"><span>Migrate the auth flow</span><span className="st">{name(s.thenId)}, {preset(s.thenId, 'hard')}</span></span>
      </div>
      <div className="awhy n-why" style={pos(16, 238, 600)} />
    </div>
  );
}

function request(c: SceneContext, ms: number, title: string, difficulty: string): void {
  c.at(ms, () => {
    const e = c.q('.n-req');
    if (!e) return;
    e.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = title;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `Helper, ${difficulty}`;
    e.append(b, sub);
    e.classList.add('in', 'lit');
  });
}

function model(c: SceneContext, ms: number, card: 'a' | 'b', id: string, difficulty: 'easy' | 'hard'): void {
  c.at(ms, () => { const e = c.q(`.n-p${card}m`); if (e) e.textContent = `${difficulty === 'easy' ? 'Easy' : 'Hard'}: ${preset(id, difficulty)}`; });
}

function path(c: SceneContext, ms: number, selector: string): void {
  c.on(ms, selector);
  c.on(ms, selector, 'hot');
}

function play(c: SceneContext): void {
  const second = (c.q('.n-root')?.getAttribute('data-second') as Second | null) ?? 'codex-cli';
  const s = story(second);
  const other = s.first === 'a' ? 'b' : 'a';
  const firstName = name(s.firstId);
  const thenName = name(s.thenId);
  c.on(0, '.n-orch, .dp, .prov');

  // An easy job: both CLIs are considered, and one gets it.
  request(c, 400, 'Rename config keys', 'easy');
  path(c, 800, '.n-rq-e');
  c.on(1000, '.n-de', 'lit');
  c.pulse(800, curve(166, 142, 196, D.e), 'var(--wt-accent)', 350);
  path(c, 1300, '.n-e-a, .n-e-b');
  model(c, 1500, 'a', 'claude-code', 'easy');
  model(c, 1500, 'b', second, 'easy');
  c.caption(1500, '.n-why', second === 'codex-cli'
    ? 'Both plans have room. Codex has more left, so it gets this one.'
    : 'Claude Code’s plan has room. Clubhouse can’t read Copilot’s, so Copilot comes last.');
  c.on(2300, `.n-p${s.first}`, 'lit');
  c.off(2300, `.n-e-${other}`, 'hot');
  c.on(2300, `.n-e-${other}`, 'gone');
  path(c, 2700, `.n-${s.first}-hp`);
  c.pulse(2700, `M500 ${V[s.first]} L534 ${V[s.first]}`, 'var(--wt-accent)', 300);
  c.on(2950, '.n-hp-first');

  // That CLI nears its limit.
  c.at(3700, () => {
    c.qa('.n-rq-e, .n-e-a, .n-e-b').forEach((e) => e.classList.add('gone'));
    c.q(`.n-${s.first}-hp`)?.classList.remove('hot');
    c.q(`.n-p${s.first}`)?.classList.remove('lit');
    c.q('.n-de')?.classList.remove('lit');
    c.q('.n-req')?.classList.remove('lit', 'in');
    c.qa('.pm').forEach((e) => { e.textContent = ' '; });
    const fill = c.q(`.n-p${s.first}f`);
    if (fill) { fill.style.width = '96%'; fill.classList.add('warn'); }
    const t = c.q(`.n-p${s.first}t`);
    if (t) { t.textContent = 'Near its limit, skipped'; t.classList.add('warnt'); }
  });
  c.caption(3800, '.n-why', `${firstName} reports 96% of its plan used. Smart routing skips it until the limit resets.`);
  c.on(4300, `.n-p${s.first}`, 'dim');

  // A hard job: only the other CLI is left.
  request(c, 5300, 'Migrate the auth flow', 'hard');
  path(c, 5700, '.n-rq-h');
  c.on(5900, '.n-dh', 'lit');
  c.pulse(5700, curve(166, 142, 196, D.h), 'var(--wt-accent)', 350);
  path(c, 6200, `.n-h-${s.then}`);
  model(c, 6400, s.then, s.thenId, 'hard');
  c.caption(6400, '.n-why', `${thenName} takes it, with the model you mapped to hard.`);
  c.on(6900, `.n-p${s.then}`, 'lit');
  path(c, 7300, `.n-${s.then}-hp`);
  c.pulse(7300, `M500 ${V[s.then]} L534 ${V[s.then]}`, 'var(--wt-accent)', 300);
  c.on(7550, '.n-hp-then');
  c.caption(8800, '.n-why', 'Each helper keeps its CLI and model, even if the limits change later.');
}

function SmartRoutingExtra() {
  return (
    <div className="wt-x">
      <Button onClick={openSmartRoutingSettings}>Open Settings › Smart routing</Button>
      <span className="wt-muted">Choose the models for each difficulty there.</span>
      <TourLink onClick={() => openHelpLink('smartRouting')}>Smart routing, in Help</TourLink>
    </div>
  );
}

export const smartRouting: SceneDef = {
  title: 'Smart routing picks a CLI for each helper',
  text: 'You have more than one CLI set up. When an orchestrator starts a helper, it says how hard the job is. Smart routing then picks the CLI with the most room left on its plan, and the model you mapped to that difficulty. It skips a plan that’s nearly used up, and each helper keeps what it was given.',
  Extra: SmartRoutingExtra,
  Stage: SmartRoutingStage,
  play,
};
