import { describe, expect, it } from 'vitest';
import { resolveMentions } from './group-project-mentions';

const members = [
  { address: 'a@one', name: 'Twin', computer: 'Mac mini' },
  { address: 'b@two', name: 'Twin', computer: 'Laptop' },
  { address: 'c@one', name: 'Solo' },
];
describe('board mentions', () => {
  it('resolves ambiguous names to every address and flags the plain name', () => {
    expect(resolveMentions('Hi @tWiN and @Twin!', members)).toEqual({ addresses: new Set(['a@one', 'b@two']), ambiguous: ['Twin'] });
  });
  it('qualifies a name with its computer, including spaces, without mentioning its twins', () => {
    expect(resolveMentions('@TWIN@mac MINI, please help @solo.', members)).toEqual({ addresses: new Set(['a@one', 'c@one']), ambiguous: [] });
    expect(resolveMentions('@Twin@missing', members).addresses.size).toBe(0);
  });
  it('keeps existing boundaries and escapes display names', () => {
    for (const text of ['mail@Twin', '@@Twin', '@Twins', '@Twin-extra', '@Twin@Laptop-extra']) {
      expect(resolveMentions(text, members).addresses.size).toBe(0);
    }
    expect(resolveMentions('(@a.b+)!', [{ name: 'a.b+', address: 'x' }]).addresses).toEqual(new Set(['x']));
    expect(resolveMentions('@', [{ name: '', address: 'x' }]).addresses.size).toBe(0);
  });
  it('combines qualified and ambiguous mentions without duplicates', () => {
    expect(resolveMentions('@Twin@Laptop @Twin', members)).toEqual({ addresses: new Set(['a@one', 'b@two']), ambiguous: ['Twin'] });
  });
});
