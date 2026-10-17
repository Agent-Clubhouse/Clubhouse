import { Tooltip } from '../../../components/Tooltip';
import { useAgentDetailsStore } from './detailsStore';

/** The pane toolbar's Agent details button (#2032); ⌥⌘D does the same. */
export function DetailsToggle() {
  const open = useAgentDetailsStore((s) => s.open);
  const toggle = useAgentDetailsStore((s) => s.toggle);
  return (
    <Tooltip content="Agent details" shortcutAction="toggle-agent-details">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={open}
        aria-label="Agent details"
        className={`w-7 h-7 rounded-md grid place-items-center hover:bg-surface-0 hover:text-ctp-text ${open ? 'bg-surface-0 text-ctp-text' : 'text-ctp-overlay1'}`}
        data-testid="agent-details-toggle"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="13" y="3" width="8" height="7" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /><path d="M3 5h6M3 10h6M3 15h6M3 20h6" />
        </svg>
      </button>
    </Tooltip>
  );
}
