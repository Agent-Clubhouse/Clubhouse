import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import { useCommandPaletteStore } from '../../stores/commandPaletteStore';
import { useUIStore } from '../../stores/uiStore';
import { CommandPaletteInput } from './CommandPaletteInput';
import { CommandPaletteList, optionId } from './CommandPaletteList';
import { useCommandSource } from './use-command-source';
import { fuzzyFilter, FuzzyFilterItem } from './fuzzy-match';
import { CATEGORY, CommandItem } from './command-registry';
import { HELP_SECTIONS } from '../help/help-content';
import { searchHelpTopics } from '../help/help-search';

const LISTBOX_ID = 'command-palette-results';
/** Help answers the same question as the palette, so a few topics join the results. */
const HELP_RESULTS = 3;

const MODE_HINTS: { prefix: string; label: string }[] = [
  { prefix: '>', label: 'commands' },
  { prefix: '@', label: 'agents' },
  { prefix: '/', label: 'projects' },
  { prefix: '#', label: 'canvases' },
];

function stripPrefix(query: string): string {
  if (query.startsWith('>') || query.startsWith('@') || query.startsWith('#') || query.startsWith('/')) {
    return query.slice(1);
  }
  return query;
}

function helpItems(query: string): FuzzyFilterItem<CommandItem>[] {
  return searchHelpTopics(HELP_SECTIONS, query).slice(0, HELP_RESULTS).map((r) => ({
    item: {
      id: `help:${r.sectionId}:${r.topic.id}`,
      label: r.topic.title,
      category: CATEGORY.help,
      icon: 'help',
      detail: r.sectionTitle,
      execute: () => {
        const ui = useUIStore.getState();
        if (ui.explorerTab !== 'help') ui.toggleHelp();
        ui.setHelpSection(r.sectionId);
        // setHelpSection clears the topic, so set it after.
        ui.setHelpTopic(r.topic.id);
      },
    },
    score: r.score,
    matches: [] as number[],
  }));
}

/**
 * The command palette (spec #2024): centered over the window in the chrome menu
 * style, with dialog semantics. Prefix modes (> @ / #) narrow the list, with
 * their hints in the footer.
 */
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
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus goes back where it was when the palette closes.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous?.isConnected && (document.activeElement === document.body || dialogRef.current?.contains(document.activeElement))) {
        previous.focus();
      }
    };
  }, [isOpen]);

  // Filter by mode
  const modeFiltered = useMemo(() => {
    if (mode === 'commands') return allCommands.filter((c) => c.category === CATEGORY.commands || c.category === CATEGORY.settings);
    if (mode === 'agents') return allCommands.filter((c) => c.category === CATEGORY.agents);
    if (mode === 'projects') return allCommands.filter((c) => c.category === CATEGORY.projects);
    if (mode === 'canvases') return allCommands.filter((c) => c.category === CATEGORY.canvases);
    return allCommands;
  }, [allCommands, mode]);

  // Fuzzy filter
  const filteredItems: FuzzyFilterItem<CommandItem>[] = useMemo(() => {
    const searchQuery = stripPrefix(query).trim();
    const filtered = fuzzyFilter(
      searchQuery ? modeFiltered : modeFiltered.filter((c) => !c.searchOnly),
      searchQuery,
      (item) => item.label,
      (item) => item.keywords || [],
    );

    // Promote recent commands: show in "Recent" group when no query,
    // boost score when query is active so recents rank higher among matches
    const recents: FuzzyFilterItem<CommandItem>[] = [];
    const rest: FuzzyFilterItem<CommandItem>[] = [];
    for (const item of filtered) {
      if (isRecent(item.item.id)) {
        if (!searchQuery) {
          recents.push({ ...item, item: { ...item.item, category: CATEGORY.recent } });
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
    const ranked = [...recents, ...rest].sort((a, b) => b.score - a.score);
    return mode === 'all' ? [...ranked, ...helpItems(searchQuery)] : ranked;
  }, [modeFiltered, query, mode, isRecent]);

  const executeItem = useCallback((item: CommandItem) => {
    recordRecent(item.id);
    close();
    item.execute();
  }, [recordRecent, close]);

  // Keyboard handler — uses React onKeyDown on the overlay div so events
  // are caught during DOM bubbling, avoiding ordering issues with other
  // window-level listeners (e.g. the global shortcut dispatcher in App).
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      // The search field is the dialog's only stop; rows are reached with the arrows.
      e.preventDefault();
      dialogRef.current?.querySelector('input')?.focus();
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
  }, [close, moveSelection, filteredItems, selectedIndex, executeItem]);

  if (!isOpen) return null;

  const activeOptionId = filteredItems[selectedIndex] ? optionId(LISTBOX_ID, selectedIndex) : undefined;

  return (
    // eslint-disable-next-line no-restricted-syntax
    <div className="fixed inset-0 z-modal" data-testid="command-palette-overlay" onKeyDown={handleKeyDown}>
      <div className="absolute inset-0 bg-ctp-crust/40" onClick={close} />
      <div className="relative flex justify-center pt-[12vh] px-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          className="pointer-events-auto w-[560px] max-w-full bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl overflow-hidden"
        >
          <CommandPaletteInput listboxId={LISTBOX_ID} activeOptionId={activeOptionId} />
          <CommandPaletteList id={LISTBOX_ID} items={filteredItems} onExecute={executeItem} />
          <div className="h-[30px] flex items-center gap-3 px-3 border-t border-surface-0 text-xs text-ctp-overlay1">
            <span className="flex gap-3" data-testid="command-palette-hints">
              {MODE_HINTS.map((hint) => (
                <span key={hint.prefix} className="flex items-center gap-1">
                  <span className="font-mono text-ctp-subtext1">{hint.prefix}</span>
                  {hint.label}
                </span>
              ))}
            </span>
            <span className="ml-auto flex gap-2.5">
              <span>↵ open</span>
              <span>↑↓ move</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
