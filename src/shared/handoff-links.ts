import { isSafeHandoffPath } from './handoff-manifest';

/** Link payloads are relative UTF-8 text, not paths at which the receiver may write. */
export function handoffLinkTarget(raw: Uint8Array): string {
  if (raw.byteLength === 0 || raw.byteLength > 4096) throw new Error('Unsafe handoff link.');
  const target = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (target.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(target) || /\p{Default_Ignorable_Code_Point}/u.test(target)) throw new Error('Unsafe handoff link.');
  for (const part of target.split('/')) if (part !== '.' && part !== '..' && !isSafeHandoffPath(part)) throw new Error('Unsafe handoff link.');
  return target;
}

/**
 * Resolve components in filesystem order. Normalizing `..` before following a
 * link is unsafe: `dir/link/../outside` may leave the root through `link`.
 * The map must describe the complete tree that will be applied, including base links.
 */
export function assertInternalHandoffLinks(links: ReadonlyMap<string, string>): void {
  const portable = new Map<string, string>();
  for (const [name, target] of links) {
    if (!isSafeHandoffPath(name)) throw new Error('Unsafe handoff link.');
    handoffLinkTarget(new TextEncoder().encode(target));
    const key = name.normalize('NFC').toLowerCase();
    if (portable.has(key)) throw new Error('Ambiguous handoff link.');
    portable.set(key, target);
  }
  for (const name of links.keys()) {
    const pending = name.split('/');
    const resolved: string[] = [];
    let followed = 0;
    while (pending.length) {
      const component = pending.shift()!;
      if (component === '.') continue;
      if (component === '..') {
        if (!resolved.length) throw new Error('Outside handoff link.');
        resolved.pop(); continue;
      }
      if (!isSafeHandoffPath(component)) throw new Error('Unsafe handoff link.');
      const current = [...resolved, component].join('/').normalize('NFC').toLowerCase();
      const target = portable.get(current);
      if (target !== undefined) {
        if (++followed > 40) throw new Error('Cyclic handoff link.');
        pending.unshift(...target.split('/'));
      } else resolved.push(component);
    }
  }
}
