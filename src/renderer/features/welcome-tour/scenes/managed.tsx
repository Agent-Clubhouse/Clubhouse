import type { ReactNode } from 'react';
import { create } from 'zustand';
import { Button } from '../../../components/Button';
import { curve } from '../scene-engine';
import { AgentStack, Av, Ov, Part, TourLink, Wire, pos } from '../stage-parts';
import { openAppSettings, openHelpLink } from '../tour-actions';
import type { SceneDef } from './types';

/**
 * Managed agents (#2819, docs/managed-agents.md). Everything shown is how it
 * really works: blocks joined in order with a blank line between and nothing
 * added, the three wildcards, the file each CLI reads, the skills folder and
 * MCP file, the save dialog, and Fork for this agent instead. The agents are
 * examples. Upgraders see `switched` first.
 */

function ManagedHelp() {
  return <TourLink onClick={() => openHelpLink('managed')}>Managed agents, in Help</TourLink>;
}

// ── Upgraders: what happened to their agents ──────────────────────────────

const SWITCHED: Array<[ch: string, name: string, before: string, now: string, ok: boolean, parts: string]> = [
  ['R', 'reviewer', 'Clubhouse Mode', 'Switched', true, 'Identity, Clubhouse basics, Orchestrator, GitHub'],
  ['A', 'api-builder', 'Persona: Developer', 'Switched', true, 'Identity, Clubhouse basics, Its earlier instructions'],
  ['W', 'docs-writer', 'Persona: Writer', 'Switches at its next start', false, 'Identity, Clubhouse basics, Its earlier instructions'],
  ['G', 'legacy-bot', 'Its own files', 'Not switched', false, 'Keeps working as before. Switch it yourself any time.'],
];

function SwitchedStage() {
  return (
    <>
      {SWITCHED.map(([ch, name, before, now, ok, parts], i) => {
        const y = 12 + i * 70;
        return (
          <div key={name}>
            <div className={`pc dash rv old n-o${i}`} style={pos(30, y + 12, 250)}><Av ch={ch} /><b>{name}</b><span className="sub">{before}</span></div>
            <div className={`arrow n-ar${i}`} style={pos(296, y + 30, 70)} />
            <div className={`pc rv newc n-n${i}`} style={pos(382, y, 330)}>
              <span className="row"><Av ch={ch} /><b>{name}</b><span className={`sub right${ok ? ' okt' : ''}`}>{now}</span></span>
              <span className="sub row">{i < 3 && <i className="kq b" />}{parts}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}

function SwitchedExtra() {
  return (
    <div className="wt-x">
      <Button onClick={() => openAppSettings('managed-switch')}>Open Switch agents</Button>
      <span className="wt-muted">For agents that weren&rsquo;t using either</span>
    </div>
  );
}

export const switched: SceneDef = {
  title: 'Your agents switched to parts',
  text: 'Personas and Clubhouse Mode are gone. Each agent that used them switched at its next start and kept what it had. Its earlier files are kept, and its Setup says where. Nothing switches while this tour is open.',
  Extra: SwitchedExtra,
  Stage: SwitchedStage,
  play: (c) => SWITCHED.forEach((_, i) => {
    const t = 200 + i * 700;
    c.on(t, `.n-o${i}`);
    c.on(t + 300, `.n-ar${i}`);
    c.on(t + 520, `.n-n${i}`);
    c.on(t + 600, `.n-o${i}`, 'dim');
  }),
};

// ── 1: instruction blocks compose into the CLI's file ─────────────────────

/** The file each CLI reads its instructions from. */
export const CLI_FILES: Array<[cli: string, file: string]> = [
  ['Claude Code', 'CLAUDE.md'],
  ['Codex', 'AGENTS.md'],
  ['Copilot', '.github/copilot-instructions.md'],
];

/** Which CLI's file the compose scene shows. Chosen outside the picture, so a keyboard reaches it. */
export const useComposeCli = create<{ cli: number; setCli: (cli: number) => void }>((set) => ({ cli: 0, setCli: (cli) => set({ cli }) }));

const BLOCKS: Array<[n: string, name: string, owner: string]> = [
  ['b1', 'Identity', 'Built-in'],
  ['b2', 'Clubhouse basics', 'Built-in'],
  ['b3', 'Developer', 'Built-in'],
  ['b4', 'Coding standards', 'Yours'],
];

function Wild({ to, children }: { to: string; children: string }) {
  return <span className="wc" data-to={to}>{children}</span>;
}

/** [block, text, block label, heading]. The empty lines are the blank line between blocks. */
const LINES: Array<[block: number, text: ReactNode, label?: string, heading?: boolean]> = [
  [1, <>You are <Wild to="api-builder">@@AgentName</Wild>, an agent working in Clubhouse.</>, 'Identity'],
  [1, <>Your workspace is <Wild to=".clubhouse/agents/api-builder/">@@Path</Wild>.</>],
  [1, <>Your standby branch is <Wild to="api-builder/standby">@@StandbyBranch</Wild>. You idle there…</>],
  [2, ''],
  [2, '# Working in Clubhouse', 'Clubhouse basics', true],
  [2, 'You are working in Clubhouse, an IDE for running coding'],
  [2, 'agents side by side. Each agent has its own workspace…'],
  [3, ''],
  [3, '# Developer', 'Developer', true],
  [3, 'You are a **developer**. You take a task and produce a'],
  [3, 'branch with the change it asks for.'],
  [4, ''],
  [4, '# Coding standards', 'Coding standards', true],
  [4, 'Prefer small functions. Name things for what they do.'],
];

function ComposeStage() {
  const cli = useComposeCli((s) => s.cli);
  const inBlock: Record<number, number> = {};
  return (
    <>
      <div className="lab" style={pos(20, 6)}>api-builder reads, in order</div>
      {BLOCKS.map(([n, name, owner], i) => (
        <div key={n} className={`pc rv n-${n}`} style={pos(20, 28 + i * 52, 230)}>
          <span className="ord">{i + 1}</span><i className="kq b" /><b>{name}</b><span className="sub">{owner}</span>
        </div>
      ))}
      <div className="pc dash rv n-add" style={pos(20, 240, 230)}><span className="wt-muted">Add a block</span></div>
      <div className="fp rv n-file" style={pos(282, 10, 446, { height: 280 })}>
        <div className="fp-h"><span className="wt-muted">api-builder/</span><b>{CLI_FILES[cli][1]}</b><span className="sp" /><span className="wt-muted">{CLI_FILES[cli][0]}</span></div>
        <div className="fp-b">
          {LINES.map(([block, text, label, heading], i) => {
            inBlock[block] = (inBlock[block] ?? 0) + 1;
            return (
              <div key={i} className={`fl l-b${block}${heading ? ' h' : ''}`} style={{ transitionDelay: `${(inBlock[block] - 1) * 70}ms` }}>
                <span className="ln">{i + 1}</span><span>{text}</span>{label && <span className="bt">{label}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function ComposeExtra() {
  const cli = useComposeCli((s) => s.cli);
  const setCli = useComposeCli((s) => s.setCli);
  return (
    <div className="wt-x">
      <span className="wt-muted" id="wt-compose-cli">Show the file for</span>
      <div className="wt-seg" role="group" aria-labelledby="wt-compose-cli">
        {CLI_FILES.map(([name], i) => (
          <button key={name} type="button" className="focus-ring" aria-pressed={i === cli} onClick={() => setCli(i)}>{name}</button>
        ))}
      </div>
      <ManagedHelp />
    </div>
  );
}

export const compose: SceneDef = {
  title: 'Instructions are blocks, joined in order',
  text: 'Pick the instruction blocks an agent reads, in the order it reads them. At every start, Clubhouse joins them into the file its CLI reads, then fills in the agent’s name, workspace and branch. It adds no text of its own.',
  Extra: ComposeExtra,
  Stage: ComposeStage,
  play: (c) => {
    c.on(0, '.n-b1, .n-b2, .n-b3, .n-b4, .n-file');
    [1, 2, 3, 4].forEach((i) => {
      const t = 500 + (i - 1) * 850;
      c.on(t, `.n-b${i}`, 'lit');
      c.on(t + 520, `.l-b${i}`);
      c.off(t + 760, `.n-b${i}`, 'lit');
      c.on(t + 760, `.n-b${i}`, 'done');
    });
    c.on(4000, '.n-add');
    c.on(4200, '.n-file', 'lit');
    c.qa('.wc').forEach((w, j) => c.at(4400 + j * 450, () => { w.textContent = w.getAttribute('data-to'); w.classList.add('done'); }));
    c.off(6000, '.n-file', 'lit');
  },
};

// ── 2: skills and MCP servers ─────────────────────────────────────────────

const ITEMS: Array<[n: string, kind: 's' | 'm', name: string, owner: string, y: number]> = [
  ['s1', 's', 'Build', 'Built-in', 22],
  ['s2', 's', 'Test', 'Built-in', 62],
  ['s3', 's', 'Playwright', 'Yours', 102],
  ['m1', 'm', 'Clubhouse', 'Always on', 168],
  ['m2', 'm', 'GitHub', 'Yours', 208],
];
const TREE: Array<[n: string, path: string, tag?: string]> = [
  ['t0', 'CLAUDE.md', 'from its blocks'],
  ['t1', '.claude/skills/'],
  ['t2', '  build/SKILL.md'],
  ['t3', '  test/SKILL.md'],
  ['t4', '  playwright/SKILL.md'],
  ['t5', '.mcp.json'],
  ['t6', '  clubhouse', 'Always on'],
  ['t7', '  github', 'needs GITHUB_TOKEN'],
];
const treeY = (i: number) => 10 + 28 + 6 + i * 18 + 9;

function SkillsStage() {
  return (
    <>
      <div className="lab" style={pos(20, 4)}>Skills</div>
      <div className="lab" style={pos(20, 150)}>MCP servers</div>
      {ITEMS.map(([n, kind, name, owner, y]) => <Part key={n} n={n} x={20} y={y} w={200} kind={kind} name={name} sub={owner} cls="sm" />)}
      <Ov>
        {ITEMS.map(([n, , , , y]) => <Wire key={n} n={`w${n}`} d={curve(220, y + 15, 290, 150)} cls={n === 'm1' ? 'in hot' : ''} />)}
        {TREE.map(([n], i) => (i > 0 ? <Wire key={n} n={`o${n}`} d={curve(410, 150, 446, treeY(i))} /> : null))}
      </Ov>
      <div className="an rv n-ag" style={pos(290, 134, 120)}><Av ch="A" /><span>api-builder</span></div>
      <div className="fp rv n-tree" style={pos(446, 10, 282, { height: 280 })}>
        <div className="fp-h"><span className="wt-muted">api-builder/</span><span className="sp" /><span className="wt-muted">Claude Code</span></div>
        <div className="fp-b">
          {TREE.map(([n, path, tag]) => (
            <div key={n} className={`fl t n-${n}`}><span>{path.replace(/ /g, ' ')}</span>{tag && <span className="tag">{tag}</span>}</div>
          ))}
          <div className="fl t n-env note">Sign-in comes from your environment. Clubhouse stores no secrets.</div>
        </div>
      </div>
    </>
  );
}

export const skills: SceneDef = {
  title: 'Skills and MCP servers come along the same way',
  text: 'Add skills and MCP servers from the library like blocks. Each start copies skills into the agent’s skills folder and writes its MCP servers where the CLI looks. The Clubhouse server is always on.',
  Extra: () => <div className="wt-x"><ManagedHelp /></div>,
  Stage: SkillsStage,
  play: (c) => {
    c.on(0, '.pc, .n-ag, .n-tree, .n-t0, .n-t5, .n-t6, .n-om1, .n-ot6');
    c.on(0, '.n-m1', 'done');
    const seq: Array<[string, number[]]> = [['s1', [1, 2]], ['s2', [3]], ['s3', [4]], ['m2', [7]]];
    seq.forEach(([n, rows], k) => {
      const t = 600 + k * 900;
      const item = ITEMS.find((x) => x[0] === n)!;
      c.on(t, `.n-${n}`, 'lit');
      c.on(t, `.n-w${n}`);
      c.on(t, `.n-w${n}`, 'hot');
      c.pulse(t + 150, curve(220, item[4] + 15, 290, 150), 'var(--wt-accent)', 500);
      rows.forEach((ti) => {
        c.on(t + 500, `.n-ot${ti}`);
        c.pulse(t + 550, curve(410, 150, 446, treeY(ti)), item[1] === 'm' ? 'var(--wt-mauve)' : 'var(--wt-green)', 380);
        c.on(t + 850, `.n-t${ti}`);
      });
      c.off(t + 900, `.n-${n}`, 'lit');
      c.on(t + 900, `.n-${n}`, 'done');
    });
    c.on(4400, '.n-env');
  },
};

// ── 3: an edit reaches every agent that uses the part ─────────────────────

const USERS: Array<[n: string, ch: string, name: string, status: string, y: number]> = [
  ['r1', 'R', 'reviewer', 'Running', 14],
  ['r2', 'A', 'api-builder', 'Idle', 78],
  ['r3', 'W', 'docs-writer', 'Sleeping', 142],
];

function UpdatesStage() {
  return (
    <>
      <Ov>
        {USERS.map(([n, , , , y]) => (
          <g key={n}>
            <Wire n={`e${n}`} d={curve(290, 76, 498, y + 25)} />
            <Wire n={`u${n}`} d={curve(290, 221, 498, y + 25)} />
          </g>
        ))}
        <Wire n="er4" d={curve(290, 76, 498, 231)} />
      </Ov>
      <div className="fp rv n-ed" style={pos(20, 10, 270, { height: 140 })}>
        <div className="fp-h"><i className="kq b" /><b>Coding standards</b><span className="sp" /><span className="wt-muted">Yours</span></div>
        <div className="fp-b">
          <div className="fl in h"><span># Coding standards</span></div>
          <div className="fl in"><span>Prefer small functions. Name things for</span></div>
          <div className="fl in"><span>what they do.</span></div>
          <div className="fl in"><span className="typed n-ty" /></div>
        </div>
        <span className="mbtn pri n-save" style={{ position: 'absolute', right: 10, bottom: 10 }}>Save</span>
      </div>
      <div className="pc rv newc n-bu" style={pos(20, 196, 270)}>
        <span className="row"><i className="kq b" /><b>Clubhouse basics</b><span className="sub">Built-in</span></span>
        <span className="sub">New text in this Clubhouse update</span>
      </div>
      {USERS.map(([n, ch, name, status, y]) => <AgentStack key={n} n={n} x={498} y={y} w={230} ch={ch} name={name} status={status} />)}
      <div className="an rv n-r4" style={pos(498, 206, 230)}>
        <i className="kq b tpl" />
        <span className="an2"><span>Template: storefront dev</span><span className="st">Lists Coding standards</span></span>
      </div>
      <div className="dlg rv n-dlg" style={pos(176, 92, 312)}>
        <b>Save Coding standards for 3 agents and 1 template?</b>
        <span className="wt-muted">Each agent gets the new version at its next start.</span>
        <div className="row"><Av ch="R" />reviewer<span className="st">Running</span><span className="cb n-cb" />Restart</div>
        <div className="row"><Av ch="A" />api-builder<span className="st">Idle</span></div>
        <div className="row"><Av ch="W" />docs-writer<span className="st">Sleeping</span></div>
        <div className="row end"><span className="mbtn">Cancel</span><span className="mbtn pri n-sv">Save</span></div>
      </div>
    </>
  );
}

export const updates: SceneDef = {
  title: 'Edit a part once and every agent gets it',
  text: 'Before you save, Clubhouse shows which agents and templates use the part. Each agent picks up the change at its next start. A running one offers Restart, which keeps the conversation. Built-in parts update the same way when Clubhouse updates.',
  Extra: () => <div className="wt-x"><ManagedHelp /></div>,
  Stage: UpdatesStage,
  play: (c) => {
    c.on(0, '.n-ed, .n-r1, .n-r2, .n-r3, .n-r4');
    c.on(300, '.n-ed', 'lit');
    c.type(500, '.n-ty', 'Prefer named exports.', 45);
    c.on(1700, '.n-save', 'press');
    c.off(1850, '.n-save', 'press');
    c.off(1850, '.n-ed', 'lit');
    c.on(1900, '.n-dlg');
    c.on(1900, '.n-ed', 'dim');
    c.on(2700, '.n-cb', 'on');
    c.at(2700, () => { const b = c.q('.n-sv'); if (b) b.textContent = 'Save and restart 1'; });
    c.on(3300, '.n-sv', 'press');
    c.off(3500, '.n-dlg', 'in');
    c.off(3500, '.n-ed', 'dim');
    USERS.forEach(([n, , , , y], i) => {
      c.on(3600, `.n-e${n}`);
      c.on(3600, `.n-e${n}`, 'hot');
      c.pulse(3650 + i * 80, curve(290, 76, 498, y + 25), 'var(--wt-accent)', 650);
      c.on(4300, `.n-${n}`, 'lit');
    });
    c.on(3600, '.n-er4');
    c.on(3600, '.n-er4', 'hot');
    c.pulse(3900, curve(290, 76, 498, 231), 'var(--wt-accent)', 650);
    c.status(4400, '.n-r1', 'Setup changed. Restarting…', 'warn');
    c.status(4400, '.n-r2', 'Gets it at its next start');
    c.status(4400, '.n-r3', 'Gets it at its next start');
    c.status(4400, '.n-r4', 'Agents made from it later get it too');
    c.status(5300, '.n-r1', 'Restarted. Conversation kept.', 'ok');
    c.at(5300, () => {
      c.qa('.an.lit').forEach((e) => e.classList.remove('lit'));
      c.qa('.w.hot').forEach((e) => e.classList.remove('hot'));
    });
    c.on(6000, '.n-er1, .n-er2, .n-er3, .n-er4', 'faint');
    c.on(6100, '.n-bu');
    c.on(6500, '.n-bu', 'lit');
    USERS.forEach(([n, , , , y], i) => {
      c.on(6600, `.n-u${n}`);
      c.on(6600, `.n-u${n}`, 'hot');
      c.pulse(6650 + i * 80, curve(290, 221, 498, y + 25), 'var(--wt-accent)', 650);
    });
    c.status(7400, '.n-r1', 'Setup changed. Restart when ready.', 'warn');
    c.off(7400, '.n-bu', 'lit');
  },
};

// ── 4: two agents share some parts and differ in others ───────────────────

const SHARED: Array<[n: string, kind: 'b' | 's', name: string, y: number]> = [
  ['i', 'b', 'Identity', 80],
  ['cb', 'b', 'Clubhouse basics', 118],
  ['cs', 'b', 'Coding standards', 156],
  ['bd', 's', 'Build', 194],
  ['ts', 's', 'Test', 232],
];

function ShareStage() {
  return (
    <>
      <Ov>
        {SHARED.map(([n, , , y]) => (
          <g key={n}>
            <Wire n={`l${n}`} d={curve(236, 28, 270, y + 15)} />
            <Wire n={`r${n}`} d={curve(470, y + 15, 504, 28)} />
          </g>
        ))}
        <Wire n="vl" d="M26 46 L26 133" />
        <Wire n="vl2" d="M26 133 L26 171" />
        <Wire n="vr" d="M714 46 L714 171" />
        <Wire n="fk" d="M26 171 L36 171" />
        {[95, 133].map((y) => <Wire key={y} n={`hl${y}`} d={`M26 ${y} L36 ${y}`} />)}
        {[95, 133, 171].map((y) => <Wire key={y} n={`hr${y}`} d={`M714 ${y} L704 ${y}`} />)}
      </Ov>
      <div className="an rv n-ra" style={pos(20, 12, 216)}><Av ch="R" /><span>reviewer</span></div>
      <div className="an rv n-aa" style={pos(504, 12, 216)}><Av ch="A" /><span>api-builder</span></div>
      <div className="lab rv n-lab" style={pos(270, 56)}>Shared</div>
      <div className="lab rv n-lab" style={pos(36, 56)}>Only reviewer</div>
      <div className="lab rv n-lab" style={pos(504, 56)}>Only api-builder</div>
      {SHARED.map(([n, kind, name, y]) => <Part key={n} n={n} x={270} y={y} w={200} kind={kind} name={name} cls="sm" />)}
      <Part n="qa" x={36} y={80} w={200} kind="b" name="Quality assurance" cls="sm" />
      <Part n="va" x={36} y={118} w={200} kind="s" name="Validate" cls="sm" />
      <Part n="dv" x={504} y={80} w={200} kind="b" name="Developer" cls="sm" />
      <Part n="pr" x={504} y={118} w={200} kind="b" name="Pull requests" cls="sm" />
      <Part n="gh" x={504} y={156} w={200} kind="m" name="GitHub" cls="sm" />
      <Part n="fork" x={270} y={156} w={200} kind="b" name="Coding standards, reviewer" cls="sm" />
      <div className="dlg rv n-fpop" style={pos(150, 196, 300, { padding: '9px 12px' })}>
        <span>Make reviewer&rsquo;s Coding standards stricter</span>
        <div className="row end"><span className="mbtn">Save for 2 agents</span><span className="mbtn n-fbtn">Fork for this agent instead</span></div>
      </div>
      <div className="lab rv n-cap cap" style={pos(270, 274)} />
    </>
  );
}

export const share: SceneDef = {
  title: 'Agents share what they have in common',
  text: 'reviewer and api-builder share five parts and keep their own roles. One edit to a shared part reaches both. To change it for one agent only, fork it for that agent. The other keeps the original, and Back to shared undoes the fork.',
  Extra: () => <div className="wt-x"><ManagedHelp /></div>,
  Stage: ShareStage,
  play: (c) => {
    c.on(100, '.n-ra, .n-aa');
    SHARED.forEach(([n], i) => { c.on(500 + i * 110, `.n-${n}`); c.on(650 + i * 110, `.n-l${n}, .n-r${n}`); });
    c.on(500, '.n-lab');
    c.on(1500, '.n-qa, .n-va, .n-dv, .n-pr, .n-gh, .n-vl, .n-vr, .n-hl95, .n-hl133, .n-hr95, .n-hr133, .n-hr171');
    c.on(2500, '.n-cs', 'lit');
    c.on(2500, '.n-lcs, .n-rcs', 'hot');
    c.at(2500, () => { const cap = c.q('.n-cap'); if (cap) { cap.textContent = 'One edit to Coding standards reaches both'; cap.classList.add('in'); } });
    c.pulse(2650, 'M270 171 C253 171 253 28 236 28', 'var(--wt-accent)', 600);
    c.pulse(2650, 'M470 171 C487 171 487 28 504 28', 'var(--wt-accent)', 600);
    c.off(3500, '.n-cs', 'lit');
    c.off(3500, '.n-lcs, .n-rcs', 'hot');
    c.off(3500, '.n-cap', 'in');
    c.on(4000, '.n-fpop');
    c.on(4000, '.n-cs', 'lit');
    c.on(4900, '.n-fbtn', 'press');
    c.off(5100, '.n-fpop', 'in');
    c.on(5100, '.n-fork');
    c.on(5100, '.n-fork', 'lit');
    c.at(5300, () => { const f = c.q('.n-fork'); if (f) f.style.left = '36px'; });
    c.on(5300, '.n-lcs', 'gone');
    c.off(5300, '.n-cs', 'lit');
    c.on(5800, '.n-vl2, .n-fk');
    c.off(6000, '.n-fork', 'lit');
    c.at(6000, () => {
      const cap = c.q('.n-cap');
      if (!cap) return;
      cap.textContent = 'reviewer has its own copy now. api-builder keeps the original.';
      cap.style.left = '36px';
      cap.classList.add('in');
    });
  },
};
