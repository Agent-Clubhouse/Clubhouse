/**
 * Which title-bar tabs fit (docs/chrome-redesign-spec.md §4.2). Pure, so the
 * rules are unit-tested on their own:
 *
 * - Tabs fill from the left, in their saved order.
 * - The active tab is always shown, taking the place of the last tab that fits.
 * - When anything overflows, the More button's width comes out of the budget.
 * - The overflow list is ordered by most recent use, then saved order.
 * - With no budget measured yet, every tab is shown.
 */
export function computeOverflow(
  tabIds: readonly string[],
  widths: Readonly<Record<string, number>>,
  budget: number,
  activeId: string | null,
  mru: readonly string[],
  moreWidth: number,
  gap = 0,
): { shown: string[]; overflow: string[] } {
  const width = (id: string) => widths[id] ?? 0;
  // Not measured yet (or hidden): show everything rather than guess.
  if (budget <= 0) return { shown: [...tabIds], overflow: [] };
  const total = tabIds.reduce((sum, id, i) => sum + width(id) + (i ? gap : 0), 0);
  if (total <= budget) return { shown: [...tabIds], overflow: [] };

  const room = budget - moreWidth - gap;
  const shown: string[] = [];
  let used = 0;
  for (const id of tabIds) {
    const next = used + width(id) + (shown.length ? gap : 0);
    if (next > room) break;
    shown.push(id);
    used = next;
  }

  if (activeId && tabIds.includes(activeId) && !shown.includes(activeId)) {
    // Make room for the active tab by dropping tabs from the end of the row.
    while (shown.length > 0 && used + gap + width(activeId) > room) {
      const dropped = shown.pop()!;
      used -= width(dropped) + (shown.length ? gap : 0);
    }
    shown.push(activeId);
  }

  const shownSet = new Set(shown);
  const rest = tabIds.filter((id) => !shownSet.has(id));
  const rank = (id: string) => { const i = mru.indexOf(id); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
  const overflow = [...rest].sort((a, b) => rank(a) - rank(b) || tabIds.indexOf(a) - tabIds.indexOf(b));
  // Keep the shown tabs in saved order even when the active one was moved in.
  return { shown: tabIds.filter((id) => shownSet.has(id)), overflow };
}

/** Put a tab at the front of a project's most-recently-used list, capped. */
export function touchMru(mru: readonly string[], tabId: string, cap = 20): string[] {
  return [tabId, ...mru.filter((id) => id !== tabId)].slice(0, cap);
}
