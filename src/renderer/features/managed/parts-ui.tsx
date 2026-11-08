import { AGENT_COLORS } from '../../../shared/name-generator';
import { WILDCARDS } from './managedApi';

/** The agent's color as a small round avatar with its initials. */
export function AgentDot({ name, color }: { name: string; color: string }) {
  const hex = AGENT_COLORS.find((c) => c.id === color)?.hex ?? color;
  const initials = name.split('-').filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  return (
    <span aria-hidden className="w-[18px] h-[18px] rounded-full flex-shrink-0 flex items-center justify-center text-[8px] font-bold text-white" style={{ background: hex }}>
      {initials}
    </span>
  );
}

/** Shown under an editor: the wildcards a block can use, with this agent's values when known. */
export function WildcardBar({ values }: { values?: Partial<Record<string, string>> }) {
  return (
    <div data-testid="managed-wildcards" className="flex flex-wrap gap-x-4 gap-y-1 px-2.5 py-2 rounded-md border border-surface-0 bg-ctp-mantle text-xs text-ctp-overlay1">
      <span>Wildcards</span>
      {WILDCARDS.map((w) => (
        <span key={w.token}>
          <code className="font-mono text-ctp-subtext1">{w.token}</code>{' '}
          {values?.[w.token] ?? w.describe}
        </span>
      ))}
    </div>
  );
}

export function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
      <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

/** What to do about env values an MCP part was stored with, which Clubhouse no longer uses (D46). */
export function droppedEnvText(names: string[]): string {
  if (names.length === 1) return `Set ${names[0]} in your environment. Clubhouse no longer stores this value.`;
  const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Set ${list} in your environment. Clubhouse no longer stores these values.`;
}

export function DroppedEnvNote({ names, testId, className = '' }: { names?: string[]; testId: string; className?: string }) {
  if (!names || names.length === 0) return null;
  return <p data-testid={testId} className={`text-xs text-ctp-warning ${className}`}>{droppedEnvText(names)}</p>;
}
