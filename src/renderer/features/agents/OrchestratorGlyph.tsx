import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { Tooltip } from '../../components/Tooltip';
import { getOrchestratorLabel } from './orchestrator-colors';

const ORCH_GLYPH: Record<string, string> = { 'claude-code': 'C', 'codex-cli': 'X', 'copilot-cli': 'G' };

/** A neutral 14px provider tile shared by the sidebar and agent views. */
export function OrchestratorGlyph({ orchestrator, details = [], focusable = true }: {
  orchestrator: string;
  details?: string[];
  /** Tree rows own keyboard focus and expose provider details in their hover card. */
  focusable?: boolean;
}) {
  const all = useOrchestratorStore((s) => s.allOrchestrators);
  const name = getOrchestratorLabel(orchestrator, all);
  const letter = ORCH_GLYPH[orchestrator] ?? (name.charAt(0).toUpperCase() || '?');
  return (
    <Tooltip content={
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-ctp-text">{name}</span>
        {details.map((line) => <span key={line}>{line}</span>)}
      </span>
    }>
      <span
        role="img"
        tabIndex={focusable ? 0 : undefined}
        aria-label={[name, ...details].join(', ')}
        data-testid="pane-orchestrator"
        className="flex-shrink-0 w-3.5 h-3.5 rounded grid place-items-center bg-surface-0 text-ctp-overlay1 text-[8.5px] font-semibold leading-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-ctp-accent"
      >
        {letter}
      </span>
    </Tooltip>
  );
}
