import { useCommandPaletteStore } from '../../stores/commandPaletteStore';
import { CommandPaletteItem } from './CommandPaletteItem';
import { CommandItem } from './command-registry';
import { FuzzyFilterItem } from './fuzzy-match';

interface Props {
  id: string;
  items: FuzzyFilterItem<CommandItem>[];
  onExecute: (item: CommandItem) => void;
}

export const optionId = (listboxId: string, index: number) => `${listboxId}-option-${index}`;

export function CommandPaletteList({ id, items, onExecute }: Props) {
  const query = useCommandPaletteStore((s) => s.query);
  const selectedIndex = useCommandPaletteStore((s) => s.selectedIndex);
  const lastInteraction = useCommandPaletteStore((s) => s.lastInteraction);
  const setSelectedIndex = useCommandPaletteStore((s) => s.setSelectedIndex);

  if (items.length === 0) {
    return (
      <div id={id} role="listbox" aria-label="Results" className="px-3 py-6 text-[13px] text-ctp-overlay1 text-center">
        {query ? <>No results for &ldquo;{query}&rdquo;</> : 'Nothing to show'}
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
    <div id={id} className="overflow-y-auto max-h-[min(520px,60vh)] pt-1 pb-1.5" role="listbox" aria-label="Results">
      {grouped.map((group, gi) => (
        <div key={`${group.category}-${gi}`} role="group" aria-labelledby={`${id}-group-${gi}`}>
          <div
            id={`${id}-group-${gi}`}
            data-testid="command-palette-group"
            className="h-[26px] px-3 flex items-center text-xs font-semibold text-ctp-overlay1"
          >
            {group.category}
          </div>
          {group.items.map(({ item: filterItem, globalIndex: index }) => (
            <CommandPaletteItem
              key={filterItem.item.id}
              id={optionId(id, index)}
              item={filterItem.item}
              matchIndices={filterItem.matches}
              isSelected={index === selectedIndex}
              scrollOnSelect={lastInteraction === 'keyboard'}
              onSelect={() => onExecute(filterItem.item)}
              onHover={() => {
                if (index !== selectedIndex) setSelectedIndex(index);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
