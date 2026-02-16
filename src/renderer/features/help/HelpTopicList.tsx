import type { HelpTopic } from './help-content';

interface HelpTopicListProps {
  sectionTitle: string;
  topics: HelpTopic[];
  activeTopicId: string | null;
  onSelectTopic: (id: string) => void;
}

export function HelpTopicList({ sectionTitle, topics, activeTopicId, onSelectTopic }: HelpTopicListProps) {
  return (
    <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden">
      <div className="px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
          {sectionTitle}
        </span>
      </div>
      <nav className="py-1 flex-1 flex flex-col overflow-y-auto">
        {topics.map((topic) => (
          <button
            key={topic.id}
            onClick={() => onSelectTopic(topic.id)}
            className={`w-full px-3 py-2 text-sm text-left cursor-pointer ${
              activeTopicId === topic.id
                ? 'text-ctp-text bg-surface-1'
                : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
            }`}
          >
            {topic.title}
          </button>
        ))}
      </nav>
    </div>
  );
}
