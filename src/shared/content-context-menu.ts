/** Copy-only content metadata: never an authority to fetch/open a URL or file. */
export interface ContentContextMenu {
  link?: string;
  path?: string;
  image?: { x: number; y: number; address?: string };
  selection?: string;
  editable: boolean;
}

export function isContentContextMenu(value: unknown): value is ContentContextMenu {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => x === undefined || (typeof x === 'string' && x.length <= 1_000_000);
  if (typeof v.editable !== 'boolean' || !text(v.link) || !text(v.path) || !text(v.selection)) return false;
  if (v.image !== undefined) {
    if (!v.image || typeof v.image !== 'object') return false;
    const image = v.image as Record<string, unknown>;
    if (!text(image.address) || ![image.x, image.y].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100_000)) return false;
  }
  return true;
}
