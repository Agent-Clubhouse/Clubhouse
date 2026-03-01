import type { PlanUpdate } from '../../../../shared/structured-events';

interface Props {
  plan: PlanUpdate;
}

/**
 * Renders plan_update events as a step-by-step progress tracker.
 */
export function PlanProgress({ plan }: Props) {
  const completed = plan.steps.filter((s) => s.status === 'completed').length;

  return (
    <div
      className="border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle"
      data-testid="plan-progress"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-0">
        <svg className="w-3.5 h-3.5 text-ctp-accent" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <line x1="5" y1="6" x2="11" y2="6" />
          <line x1="5" y1="8" x2="11" y2="8" />
          <line x1="5" y1="10" x2="9" y2="10" />
        </svg>
        <span className="text-xs font-medium text-ctp-text">Plan</span>
        <span className="text-[10px] text-ctp-subtext0 ml-auto tabular-nums">
          {completed}/{plan.steps.length} complete
        </span>
      </div>
      <div className="px-3 py-2 space-y-1.5">
        {plan.steps.map((step, i) => (
          <div key={i} className="flex items-start gap-2">
            <StepIcon status={step.status} />
            <span
              className={`text-xs leading-relaxed ${
                step.status === 'completed'
                  ? 'text-ctp-subtext0 line-through'
                  : step.status === 'in_progress'
                    ? 'text-ctp-text font-medium'
                    : step.status === 'failed'
                      ? 'text-red-400'
                      : 'text-ctp-subtext0'
              }`}
            >
              {step.description}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return (
        <svg className="w-3.5 h-3.5 text-green-400 flex-shrink-0 mt-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 8 7 11 12 5" />
        </svg>
      );
    case 'in_progress':
      return (
        <span className="w-3.5 h-3.5 flex items-center justify-center flex-shrink-0 mt-0.5">
          <span className="w-2 h-2 rounded-full bg-ctp-accent animate-pulse" />
        </span>
      );
    case 'failed':
      return (
        <svg className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="5" y1="5" x2="11" y2="11" />
          <line x1="11" y1="5" x2="5" y2="11" />
        </svg>
      );
    default: // pending
      return (
        <span className="w-3.5 h-3.5 flex items-center justify-center flex-shrink-0 mt-0.5">
          <span className="w-2 h-2 rounded-full border border-ctp-subtext0" />
        </span>
      );
  }
}
