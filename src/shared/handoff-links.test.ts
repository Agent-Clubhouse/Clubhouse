import { describe, expect, it } from 'vitest';
import { assertInternalHandoffLinks, handoffLinkTarget } from './handoff-links';
const bytes = (text: string) => new TextEncoder().encode(text);
describe('portable internal handoff symlinks', () => {
  it('allows relative files, internal parent traversal, chains and the worktree root', () => {
    expect(handoffLinkTarget(bytes('../fixture.txt'))).toBe('../fixture.txt');
    expect(() => assertInternalHandoffLinks(new Map([
      ['fixture-link', 'data/fixture.txt'], ['src/link', '../fixture-link'], ['root', '.'],
    ]))).not.toThrow();
  });
  it.each(['/outside', 'C:/outside', 'C:\\outside', '//server/share', '../outside', 'a/../../outside', '.git/config', '.GiT/config', 'git~1/config'])('refuses an outside or Git-internal target: %s', (target) => {
    expect(() => { const link = handoffLinkTarget(bytes(target)); assertInternalHandoffLinks(new Map([['link', link]])); }).toThrow();
  });
  it('follows links before parent traversal and refuses escaping chains', () => {
    // Each target looks internal after lexical normalization; filesystem order escapes.
    expect(() => assertInternalHandoffLinks(new Map([['dir/link', '..'], ['entry', 'dir/link/../outside']]))).toThrow('Outside');
    expect(() => assertInternalHandoffLinks(new Map([['inner/link', '..'], ['entry', 'inner/link/.git/config']]))).toThrow();
  });
  it('rejects cycles, portable collisions, control/ambiguous bytes and oversized targets', () => {
    expect(() => assertInternalHandoffLinks(new Map([['a', 'b'], ['b', 'a']]))).toThrow('Cyclic');
    expect(() => assertInternalHandoffLinks(new Map([['A', 'file'], ['a', 'other']]))).toThrow('Ambiguous');
    for (const value of [bytes(''), bytes('a\nfile'), bytes('a\u200bfile'), bytes('a//b'), bytes('a'.repeat(4097)), new Uint8Array([0xff])]) expect(() => handoffLinkTarget(value)).toThrow();
  });
});
