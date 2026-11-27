import { TourLink } from '../stage-parts';
import type { ReactNode } from 'react';
import { prefersReducedMotion } from '../scene-engine';
import { openHelpLink, type HelpLink } from '../tour-actions';
import type { SceneDef } from './types';

/** Also new: one small moving picture per area that's learned where it lives. */

const FONT = '-apple-system, BlinkMacSystemFont, sans-serif';

function Moving({ path, dur, begin = '0s', color }: { path: string; dur: string; begin?: string; color: string }) {
  if (prefersReducedMotion()) return null;
  return <circle r={3} fill={color}><animateMotion dur={dur} begin={begin} repeatCount="indefinite" path={path} /></circle>;
}

function Tiny({ x, y, end, children }: { x: number; y: number; end?: boolean; children: ReactNode }) {
  return <text x={x} y={y} fill="var(--wt-o1)" fontSize={9} fontFamily={FONT} textAnchor={end ? 'end' : undefined}>{children}</text>;
}

const MINIS: Record<string, () => ReactNode> = {
  access: () => (
    <>
      <line x1={14} y1={26} x2={146} y2={26} stroke="var(--wt-s1)" strokeWidth={3} strokeLinecap="round" />
      {[14, 47, 80, 113, 146].map((x) => <circle key={x} cx={x} cy={26} r={2.5} fill="var(--wt-s2)" />)}
      <circle className="knob" cx={14} cy={26} r={7} fill="var(--wt-accent)" />
      <Tiny x={14} y={50}>Plan</Tiny>
      <Tiny x={146} y={50} end>Full access</Tiny>
    </>
  ),
  conn: () => (
    <>
      <circle cx={24} cy={31} r={9} fill="var(--wt-peach)" />
      <circle cx={136} cy={31} r={9} fill="var(--wt-green)" />
      <path d="M36 26 L124 26" stroke="var(--wt-accent)" strokeWidth={1.4} />
      <path d="M124 36 L36 36" stroke="var(--wt-o1)" strokeWidth={1.4} />
      <Moving path="M36 26 L124 26" dur="1.6s" color="var(--wt-accent)" />
      <Moving path="M124 36 L36 36" dur="1.6s" begin=".8s" color="var(--wt-sub)" />
    </>
  ),
  group: () => {
    const colors = ['var(--wt-peach)', 'var(--wt-green)', 'var(--wt-teal)'];
    return (
      <>
        {[12, 28, 44].map((y, i) => (
          <g key={y}>
            <rect x={10} y={y - 6} width={40} height={12} rx={3} fill="var(--wt-s0)" />
            <circle cx={17} cy={y} r={3} fill={colors[i]} />
            <path d={`M50 ${y} L76 31`} stroke="var(--wt-s1)" strokeWidth={1} />
          </g>
        ))}
        <rect x={78} y={6} width={72} height={50} rx={5} fill="none" stroke="var(--wt-s2)" />
        {[16, 28, 40].map((y, i) => (
          <rect key={y} className={`gp${i ? ` d${i + 1}` : ''}`} x={85} y={y} width={[52, 40, 46][i]} height={7} rx={3} fill={colors[i]} opacity={0.75} />
        ))}
      </>
    );
  },
  actions: () => (
    <>
      <circle cx={22} cy={31} r={11} fill="none" stroke="var(--wt-yellow)" strokeWidth={1.5} />
      <path d="M22 24 V31 L27 34" stroke="var(--wt-yellow)" strokeWidth={1.5} fill="none" strokeLinecap="round" />
      <path d="M33 31 L142 31" stroke="var(--wt-s1)" strokeWidth={1.4} />
      <rect x={58} y={21} width={34} height={20} rx={4} fill="var(--wt-s0)" stroke="var(--wt-s2)" />
      <rect x={110} y={21} width={34} height={20} rx={4} fill="var(--wt-s0)" stroke="var(--wt-s2)" />
      <Moving path="M33 31 L144 31" dur="2s" color="var(--wt-yellow)" />
    </>
  ),
  annex: () => (
    <>
      {[10, 100].map((x) => (
        <g key={x}>
          <rect x={x} y={12} width={50} height={32} rx={3} fill="var(--wt-mantle)" stroke="var(--wt-s2)" />
          <path d={`M${x - 5} 48 L${x + 55} 48`} stroke="var(--wt-s2)" strokeWidth={2.5} strokeLinecap="round" />
        </g>
      ))}
      <circle cx={27} cy={28} r={5} fill="var(--wt-peach)" />
      <circle cx={42} cy={28} r={5} fill="var(--wt-green)" />
      <circle cx={125} cy={28} r={5} fill="var(--wt-mauve)" />
      <path className="dashmove" d="M62 28 L98 28" stroke="var(--wt-accent)" strokeWidth={1.5} />
    </>
  ),
  privacy: () => (
    <>
      <rect x={24} y={12} width={52} height={32} rx={3} fill="var(--wt-mantle)" stroke="var(--wt-s2)" />
      <path d="M19 48 L81 48" stroke="var(--wt-s2)" strokeWidth={2.5} strokeLinecap="round" />
      <path d="M45 27 v-3 a5 5 0 0 1 10 0 v3" stroke="var(--wt-green)" strokeWidth={1.6} fill="none" />
      <rect x={42} y={27} width={16} height={11} rx={2} fill="var(--wt-green)" />
      <path d="M86 28 L118 28" stroke="var(--wt-s1)" strokeWidth={1.4} strokeDasharray="3 3" />
      <circle cx={132} cy={28} r={10} fill="none" stroke="var(--wt-s1)" strokeWidth={1.4} />
      <path d="M125 35 L139 21" stroke="var(--wt-s2)" strokeWidth={1.4} />
    </>
  ),
  usage: () => (
    <>
      <path d="M10 12 L150 12" stroke="var(--wt-red)" strokeWidth={1} strokeDasharray="3 3" />
      {[22, 30, 18, 38, 26, 34, 42].map((h, i) => (
        <rect key={i} className="bar" style={{ animationDelay: `${i * 80}ms` }} x={16 + i * 19} y={54 - h} width={11} height={h} rx={2} fill={i === 6 ? 'var(--wt-accent)' : 'var(--wt-s2)'} />
      ))}
    </>
  ),
  help: () => (
    <>
      <rect x={16} y={18} width={128} height={26} rx={6} fill="var(--wt-mantle)" stroke="var(--wt-s2)" />
      <circle cx={31} cy={30} r={5} fill="none" stroke="var(--wt-o1)" strokeWidth={1.4} />
      <path d="M35 34 L38 37" stroke="var(--wt-o1)" strokeWidth={1.4} />
      <text x={45} y={34} fill="var(--wt-sub)" fontSize={10} fontFamily={FONT}>welcome tour</text>
    </>
  ),
};

const CARDS: Array<[kind: keyof typeof MINIS, title: string, line: string, link: HelpLink | null]> = [
  ['access', 'Access', 'One setting for how much an agent does without asking', 'access'],
  ['conn', 'Connections', 'Link two agents so they can message and wake each other', 'connections'],
  ['group', 'Group projects', 'Several projects and their agents on one board', 'groupProjects'],
  ['actions', 'Actions', 'Small workflows that run when something happens', 'actions'],
  ['annex', 'Annex Network', 'Join your computers so they work as one', 'annex'],
  ['privacy', 'Privacy', 'Diagnostics stay on this computer unless you turn sharing on', 'privacy'],
  ['usage', 'Usage', 'Plan limits and what your agents used, from local files', 'usage'],
  ['help', 'Help', 'Search for any of this, or reopen this tour', null],
];

function AlsoNewStage() {
  return (
    <ul className="ag">
      {CARDS.map(([kind, title, line, link], i) => (
        <li key={kind} className={`agc n-g${i}`}>
          <svg viewBox="0 0 160 62" preserveAspectRatio="xMidYMid meet" aria-hidden="true">{MINIS[kind]()}</svg>
          <b>{title}</b>
          <span>{line}</span>
          <span className="agc-link">
            <TourLink onClick={() => openHelpLink(link)} label={link ? `${title} in Help` : 'Open Help'}>{link ? 'In Help' : 'Open Help'}</TourLink>
          </span>
        </li>
      ))}
    </ul>
  );
}

export const alsoNew: SceneDef = {
  title: (variant) => (variant === 'new' ? 'Also in Clubhouse' : 'Also new in 1.0'),
  text: 'These are where you’d expect them. Help has a page for each one.',
  Stage: AlsoNewStage,
  tall: true,
  play: (c) => CARDS.forEach((_, i) => c.on(80 + i * 90, `.n-g${i}`)),
};
