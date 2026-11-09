import { describe, expect, it } from 'vitest';
import { describeUsage, formatTokenCount } from './dispatcher-settings-page';

describe('usage in plain words (#3046)', () => {
  it('shortens token counts', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(1_200)).toBe('1.2K');
    expect(formatTokenCount(48_200)).toBe('48K');
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
    expect(formatTokenCount(-3)).toBe('0');
  });

  it('describes one side of the split', () => {
    expect(describeUsage({ turns: 0, input: 0, output: 0 })).toBe('None yet');
    expect(describeUsage({ turns: 1, input: 1_200_000, output: 48_000 })).toBe('1 turn, 1.2M tokens in and 48K out');
    expect(describeUsage({ turns: 3, input: 900, output: 12 })).toBe('3 turns, 900 tokens in and 12 out');
  });
});
