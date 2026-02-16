import { SkillEntry, AgentTemplateEntry } from '../../../shared/types';

type Item = SkillEntry | AgentTemplateEntry;

interface Props {
  kind: 'skill' | 'agent-template';
  items: Item[];
  onView: (item: Item) => void;
  onAdd: () => void;
  emptyMessage?: string;
}

export function SkillAgentList({ kind, items, onView, onAdd, emptyMessage }: Props) {
  const label = kind === 'skill' ? 'Skill' : 'Agent Template';

  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <div className="text-xs text-ctp-subtext0 bg-surface-0 rounded-lg p-3 flex items-center justify-between">
          <span>{emptyMessage || `No ${label.toLowerCase()}s yet.`}</span>
          <button
            onClick={onAdd}
            className="text-xs text-ctp-blue hover:text-ctp-blue/80 cursor-pointer transition-colors"
          >
            + Add {label}
          </button>
        </div>
      ) : (
        <>
          {items.map((item) => (
            <div key={item.name} className="bg-surface-0 rounded-lg px-3 py-2 border border-surface-1 flex items-center gap-2">
              <span className="text-sm text-ctp-text font-medium flex-1">{item.name}</span>
              {item.hasReadme && (
                <span className="text-[10px] bg-surface-2 text-ctp-subtext0 px-1.5 py-0.5 rounded">README</span>
              )}
              <button
                onClick={() => onView(item)}
                className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0
                  hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
              >
                View
              </button>
            </div>
          ))}
          <button
            onClick={onAdd}
            className="w-full text-xs text-ctp-blue hover:text-ctp-blue/80 cursor-pointer
              transition-colors py-2 rounded-lg border border-dashed border-surface-2
              hover:border-ctp-blue/30"
          >
            + Add {label}
          </button>
        </>
      )}
    </div>
  );
}
