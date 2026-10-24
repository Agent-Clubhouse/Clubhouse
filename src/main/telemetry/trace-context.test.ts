import { describe, expect, it } from 'vitest';
import { parseWireTraceparent, validatedTraceparent } from './trace-context';
const tc = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
describe('Annex wire context', () => {
  it('accepts only bounded version-00 sampled context and normalizes flags', () => {
    expect(validatedTraceparent(tc)).toBe(tc);
    expect(validatedTraceparent(tc.slice(0, -2) + '03')).toBe(tc);
    for (const invalid of [undefined, {}, [tc], tc + ', ' + tc, tc.toUpperCase(), tc + ' ',
      tc.replace('00-', 'ff-'), tc.slice(0, -2) + '00', 'x'.repeat(100000),
      tc.replace('0123456789abcdef0123456789abcdef', '0'.repeat(32)),
      tc.replace('-0123456789abcdef-', '-' + '0'.repeat(16) + '-')]) {
      expect(parseWireTraceparent(invalid)).toBeUndefined();
    }
  });
});
