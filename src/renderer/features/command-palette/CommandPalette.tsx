import { useEffect, useMemo, useCallback } from 'react';
import { useCommandPaletteStore } from '../../stores/commandPaletteStore';
import { CommandPaletteInput } from './CommandPaletteInput';
import { CommandPaletteList } from './CommandPaletteList';
import { useCommandSource } from './use-command-source';
import { fuzzyFilter, FuzzyFilterItem } from './fuzzy-match';
import { CommandItem } from './command-registry';

function stripPrefix(query: string): string {
  if (query.startsWith('>') || query.startsWith('@') || query.startsWith('#')) {
    return query.slice(1);
  }
  return query;
}

export function CommandPalette() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const query = useCommandPaletteStore((s) => s.query);
  const mode = useCommandPaletteStore((s) => s.mode);
  const close = useCommandPaletteStore((s) => s.close);
  const moveSelection = useCommandPaletteStore((s) => s.moveSelection);
  const selectedIndex = useCommandPaletteStore((s) => s.selectedIndex);
  const recordRecent = useCommandPaletteStore((s) => s.recordRecent);
  const isRecent = useCommandPaletteStore((s) => s.isRecent);
  const allCommands = useCommandSource();

  // Filter by mode
  const modeFiltered = useMemo(() => {
    if (mode === 'commands') return allCommands.filter((c) => c.category === 'Actions' || c.category === 'Settings' || c.category === 'Navigation');
    if (mode === 'agents') return allCommands.filter((c) => c.category === 'Agents');
    if (mode === 'projects') return allCommands.filter((c) => c.category === 'Projects');
    return allCommands;
  }, [allCommands, mode]);

  // Fuzzy filter
  const filteredItems: FuzzyFilterItem<CommandItem>[] = useMemo(() => {
    const searchQuery = stripPrefix(query).trim();
    const filtered = fuzzyFilter(
      modeFiltered,
      searchQuery,
      (item) => item.label,
      (item) => item.keywords || [],
    );

    // Promote recent commands: show in "Recently Used" group when no query,
    // boost score when query is active so recents rank higher among matches
    const recents: FuzzyFilterItem<CommandItem>[] = [];
    const rest: FuzzyFilterItem<CommandItem>[] = [];
    for (const item of filtered) {
      if (isRecent(item.item.id)) {
        if (!searchQuery) {
          recents.push({ ...item, item: { ...item.item, category: 'Recently Used' } });
        } else {
          recents.push({ ...item, score: item.score + 20 });
        }
      } else {
        rest.push(item);
      }
    }

    if (!searchQuery) {
      return [...recents, ...rest];
    }

    // Re-sort with boosted scores
    return [...recents, ...rest].sort((a, b) => b.score - a.score);
  }, [modeFiltered, query, isRecent]);

  const executeItem = useCallback((item: CommandItem) => {
    recordRecent(item.id);
    close();
    item.execute();
  }, [recordRecent, close]);

  // Keyboard handler
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(1, filteredItems.length - 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(-1, filteredItems.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = filteredItems[selectedIndex];
        if (selected) executeItem(selected.item);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, close, moveSelection, filteredItems, selectedIndex, executeItem]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50" data-testid="command-palette-overlay">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={close} />
      {/* Palette */}
      <div className="relative flex justify-center pt-[15vh]">
        <div className="w-[560px] bg-ctp-mantle border border-surface-0 rounded-lg shadow-2xl overflow-hidden">
          <CommandPaletteInput />
          <CommandPaletteList items={filteredItems} onExecute={executeItem} />
        </div>
      </div>
    </div>
  );
}
