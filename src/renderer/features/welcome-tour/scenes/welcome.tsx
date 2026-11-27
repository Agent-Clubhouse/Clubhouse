import { AgentClis } from '../../../chrome/pages/FirstRun';
import { Av, Ov, TourLink, Wire, pos } from '../stage-parts';
import { findHelpTopic, HELP_LINKS, openHelpLink } from '../tour-actions';
import type { SceneDef } from './types';

/** Welcome, new: agents side by side, each on its own branch, and the one that needs you. */
const LANES: Array<[y: number, x: number, ch: string, name: string]> = [
  [56, 90, 'R', 'reviewer'],
  [122, 130, 'A', 'api-builder'],
  [188, 170, 'W', 'docs-writer'],
];
const COMMITS = [250, 330, 410];

function WelcomeNewStage() {
  return (
    <>
      <Ov>
        <Wire n="main" d="M40 262 L700 262" cls="main" />
        {LANES.map(([y, x], i) => (
          <Wire key={i} n={`lane${i}`} d={`M${x} 262 C${x} ${y + 50} ${x + 10} ${y} ${x + 60} ${y} L446 ${y}`} cls="slow" />
        ))}
        {LANES.map(([y], i) => COMMITS.map((x, j) => (
          <circle key={`${i}${j}`} className={`rv n-c${i}${j}`} cx={x} cy={y} r={4} fill="var(--wt-s2)" />
        )))}
      </Ov>
      <div className="lab mono" style={pos(40, 272)}>main</div>
      {LANES.map(([y, x, ch, name], i) => (
        <div key={name} className={`an rv go n-a${i}`} style={pos(x + 50, y - 15, 200)}>
          <Av ch={ch} /><span>{name}</span><span className="st">Working</span>
        </div>
      ))}
      <div className="pill rv n-needs" style={pos(596, 12)}>
        <span className="dot" />Needs you<span className="cnt zero n-cnt">0</span>
      </div>
    </>
  );
}

function WelcomeNewExtra() {
  return (
    <div className="wt-x wt-clis">
      <span className="wt-muted">Agent CLIs on this computer</span>
      <AgentClis />
    </div>
  );
}

export const welcomeNew: SceneDef = {
  title: 'Welcome to Clubhouse',
  text: 'Run coding agents side by side, each on its own branch. Clubhouse keeps track of what each one is doing and tells you when one needs you.',
  Extra: WelcomeNewExtra,
  Stage: WelcomeNewStage,
  play: (c) => {
    c.on(100, '.n-main');
    c.on(500, '.n-a0, .n-a1, .n-a2');
    c.at(700, () => {
      c.qa('.n-lane0, .n-lane1, .n-lane2').forEach((e) => e.classList.add('in'));
      c.qa('.an.go').forEach((e) => { e.style.left = '452px'; });
    });
    [0, 1, 2].forEach((i) => COMMITS.forEach((_, j) => c.on(1300 + j * 520 + i * 90, `.n-c${i}${j}`)));
    c.status(3200, '.n-a0', 'Idle', 'ok');
    c.on(3300, '.n-needs');
    c.status(3600, '.n-a1', 'Needs you', 'warn');
    c.at(4400, () => { const n = c.q('.n-cnt'); if (n) { n.textContent = '1'; n.classList.remove('zero'); n.classList.add('bump'); } });
    c.off(4650, '.n-cnt', 'bump');
    c.status(4900, '.n-a2', 'Sleeping');
    c.on(4900, '.n-a2', 'dim');
  },
};

/** Welcome, upgrading: each old thing turns into its new one, in turn. */
const MOVED: Array<[before: string, now: string, note: string]> = [
  ['Free Agent Mode', 'Access', 'Set to what you had, on each agent'],
  ['Personas, Clubhouse Mode', 'Managed agents', 'Your agents are built from parts now'],
  ['Annex, Annex control', 'Annex Network', 'One page for all your computers'],
  ['The classic layout', 'The new layout', 'Classic stays in Settings › Display & UI for now'],
  ['Home, Hub, Lounge, KanBoss, Bug Report', 'Removed', 'Along with their saved data'],
];

function WelcomeUpgradeStage() {
  return (
    <>
      {MOVED.map(([before, now, note], i) => {
        const y = 14 + i * 56;
        return (
          <div key={before}>
            <div className={`pc dash rv old n-o${i}`} style={pos(40, y + 6, 250)}><b>{before}</b></div>
            <div className={`arrow n-ar${i}`} style={pos(306, y + 23, 84)} />
            <div className={`pc rv newc n-n${i}`} style={pos(408, y, 292)}><b>{now}</b><span className="sub">{note}</span></div>
          </div>
        );
      })}
    </>
  );
}

function WelcomeUpgradeExtra() {
  // Coming from classic (#3899) is the page for this; until it's in Help there's nothing to link to.
  if (!findHelpTopic(HELP_LINKS.fromClassic)) return null;
  return (
    <div className="wt-x">
      <TourLink onClick={() => openHelpLink('fromClassic')}>Everything that changed, in Help</TourLink>
    </div>
  );
}

export const welcomeUpgrade: SceneDef = {
  title: 'Welcome to Clubhouse 1.0',
  lead: 'Thank you for being part of early access. You used Clubhouse before it was finished, told us what broke and what you needed, and a lot of 1.0 comes from that.',
  text: 'Your projects, agents and settings are all still here. This is what moved.',
  Extra: WelcomeUpgradeExtra,
  Stage: WelcomeUpgradeStage,
  play: (c) => {
    MOVED.forEach((_, i) => {
      const t = 200 + i * 650;
      c.on(t, `.n-o${i}`);
      c.on(t + 300, `.n-ar${i}`);
      c.on(t + 520, `.n-n${i}`);
      c.on(t + 600, `.n-o${i}`, 'gone');
      c.on(t + 600, `.n-o${i}`, 'dim');
    });
  },
};
