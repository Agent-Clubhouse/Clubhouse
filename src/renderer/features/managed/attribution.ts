/**
 * Who changed a part, setup or template and when (#2900, D90), and what a
 * helper was built from (#2899, D91), as Details and the library say them.
 */
import { formatAgo } from '../agents/states/format';

/** "Changed by Dispatcher, 2m ago." or "Changed 2m ago." */
export function changedLine(updatedAt: string | undefined, updatedBy?: string, now = Date.now()): string {
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  const when = Number.isFinite(t) ? formatAgo(t, now) : '';
  if (updatedBy) return when ? `Changed by ${updatedBy}, ${when}.` : `Changed by ${updatedBy}.`;
  return when ? `Changed ${when}.` : 'Changed since you opened it.';
}

/**
 * "Helper template, plus Playwright, minus code-review". `nameOf` gives a
 * part's library name, or undefined for one no longer in the library.
 */
export function builtFromLine(
  templateName: string | null,
  changes: { added: string[]; removed: string[] },
  nameOf: (id: string) => string | undefined,
): string {
  const names = (ids: string[]) => {
    const known = ids.flatMap((id) => { const n = nameOf(id); return n ? [n] : []; });
    const gone = ids.length - known.length;
    return gone > 0 ? [...known, gone === 1 ? 'a part no longer in the library' : `${gone} parts no longer in the library`] : known;
  };
  const added = names(changes.added);
  const removed = names(changes.removed);
  return [
    templateName ? `${templateName} template` : 'Its template',
    ...(added.length > 0 ? [`plus ${added.join(', ')}`] : []),
    ...(removed.length > 0 ? [`minus ${removed.join(', ')}`] : []),
  ].join(', ');
}
