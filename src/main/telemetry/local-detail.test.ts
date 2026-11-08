import { describe, expect, it } from 'vitest';
import { sanitizeLocalDetail } from './local-detail';

describe('sanitizeLocalDetail (#2920)', () => {
  it('keeps booleans, whole numbers, null and short words or ids, one level deep', () => {
    expect(sanitizeLocalDetail({
      key: 'helper_presets.claude-code.hard', before: 3, after: null, on: true,
      requested: { provider: 'codex-cli', fields: ['max_helpers', 'two_way'] },
    })).toEqual({ key: 'helper_presets.claude-code.hard', before: 3, after: null, on: true, requested: { provider: 'codex-cli', fields: ['max_helpers', 'two_way'] } });
  });

  it('leaves out text, paths, fractions, deeper nesting and odd keys', () => {
    expect(sanitizeLocalDetail({
      note: 'a sentence with spaces', path: '/Users/sam/project', ratio: 0.5, deep: { more: { x: 1 } },
      'bad key': 1, list: ['ok', 'not ok'], kept: 'yes',
    })).toEqual({ deep: {}, kept: 'yes' });
  });

  it('caps lists at eight and gives nothing for an empty or non-object detail', () => {
    expect(sanitizeLocalDetail({ ids: Array.from({ length: 12 }, (_, i) => `id${i}`) })).toEqual({ ids: Array.from({ length: 8 }, (_, i) => `id${i}`) });
    expect(sanitizeLocalDetail({})).toBeUndefined();
    expect(sanitizeLocalDetail('text')).toBeUndefined();
    expect(sanitizeLocalDetail([1])).toBeUndefined();
  });
});
