import { useCommandPaletteStore } from '../../stores/commandPaletteStore';
import { CommandPaletteItem } from './CommandPaletteItem';
import { CommandItem } from './command-registry';
import { FuzzyFilterItem } from './fuzzy-match';

interface Props {
  items: FuzzyFilterItem<CommandItem>[];
  onExecute: (item: CommandItem) => void;
}

export function CommandPaletteList({ items, onExecute }: Props) {
  const query = useCommandPaletteStore((s) => s.query);
  const selectedIndex = useCommandPaletteStore((s) => s.selectedIndex);
  const setSelectedIndex = useCommandPaletteStore((s) => s.moveSelection);

  if (items.length === 0 && query) {
    return (
      <div className="px-4 py-8 text-sm text-ctp-subtext0 text-center">
        No results found for &ldquo;{query}&rdquo;
      </div>
    );
  }

  // Group items by category preserving order
  const grouped: { category: string; items: { item: FuzzyFilterItem<CommandItem>; globalIndex: number }[] }[] = [];
  let currentCategory = '';
  let globalIndex = 0;

  for (const filterItem of items) {
    const cat = filterItem.item.category;
    if (cat !== currentCategory) {
      grouped.push({ category: cat, items: [] });
      currentCategory = cat;
    }
    grouped[grouped.length - 1].items.push({ item: filterItem, globalIndex });
    globalIndex++;
  }

  return (
    <div className="overflow-y-auto max-h-[60vh]" role="listbox">
      {grouped.map((group) => (
        <div key={group.category}>
          <div className="px-4 pt-3 pb-1 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
            {group.category}
          </div>
          {group.items.map(({ item: filterItem, globalIndex: gi }) => (
            <CommandPaletteItem
              key={filterItem.item.id}
              label={filterItem.item.label}
              detail={filterItem.item.detail}
              shortcut={filterItem.item.shortcut}
              matchIndices={filterItem.matches}
              isSelected={gi === selectedIndex}
              onSelect={() => onExecute(filterItem.item)}
              onHover={() => {
                // Set absolute index by computing delta
                const delta = gi - selectedIndex;
                if (delta !== 0) setSelectedIndex(delta, items.length - 1);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
