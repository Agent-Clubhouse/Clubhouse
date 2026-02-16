import type { HelpSection } from './help-content';

interface HelpSectionNavProps {
  sections: HelpSection[];
  pluginSections: HelpSection[];
  activeSectionId: string;
  onSelectSection: (id: string) => void;
}

export function HelpSectionNav({ sections, pluginSections, activeSectionId, onSelectSection }: HelpSectionNavProps) {
  return (
    <div className="flex flex-col bg-ctp-mantle border-r border-surface-0 h-full">
      <div className="px-3 py-3 border-b border-surface-0">
        <h2 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Help</h2>
      </div>
      <nav className="flex-1 py-1 flex flex-col overflow-y-auto">
        <div className="px-3 pt-2 pb-1">
          <span className="text-[10px] font-semibold text-ctp-subtext0 uppercase tracking-wider">Features</span>
        </div>
        {sections.map((section) => (
          <button
            key={section.id}
            onClick={() => onSelectSection(section.id)}
            className={`
              w-full px-3 py-2.5 text-left text-sm flex items-center gap-3
              transition-colors duration-100 cursor-pointer
              ${activeSectionId === section.id
                ? 'bg-surface-1 text-ctp-text'
                : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
              }
            `}
          >
            {section.title}
          </button>
        ))}

        {pluginSections.length > 0 && (
          <>
            <div className="w-full border-t border-surface-0 my-1" />
            <div className="px-3 pt-2 pb-1">
              <span className="text-[10px] font-semibold text-ctp-subtext0 uppercase tracking-wider">Plugins</span>
            </div>
            {pluginSections.map((section) => (
              <button
                key={section.id}
                onClick={() => onSelectSection(section.id)}
                className={`
                  w-full px-3 py-2.5 text-left text-sm flex items-center gap-3
                  transition-colors duration-100 cursor-pointer
                  ${activeSectionId === section.id
                    ? 'bg-surface-1 text-ctp-text'
                    : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
                  }
                `}
              >
                {section.title}
              </button>
            ))}
          </>
        )}
      </nav>
    </div>
  );
}
