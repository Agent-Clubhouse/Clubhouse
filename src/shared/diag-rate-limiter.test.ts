import { describe, expect, it } from 'vitest';
import { createDiagRateLimiter } from './diag-rate-limiter';

describe('createDiagRateLimiter', () => {
  it('lets maxPerWindow lines through per key, then reports what it held back', () => {
    let t = 0;
    const limiter = createDiagRateLimiter(2, 1000, () => t);
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBeNull();
    expect(limiter.take('a')).toBeNull();
    // Other keys have their own budget.
    expect(limiter.take('b')).toBe(0);
    t = 1000;
    expect(limiter.take('a')).toBe(2);
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBeNull();
  });

  it('frees budget as old lines leave the window', () => {
    let t = 0;
    const limiter = createDiagRateLimiter(1, 100, () => t);
    expect(limiter.take('k')).toBe(0);
    t = 99;
    expect(limiter.take('k')).toBeNull();
    t = 100;
    expect(limiter.take('k')).toBe(1);
  });

  it('forgets keys by prefix, dropping their budget and held count', () => {
    const limiter = createDiagRateLimiter(1, 1000, () => 0);
    limiter.take('s1:resize');
    limiter.take('s1:resize');
    limiter.take('s2:resize');
    limiter.forget('s1:');
    expect(limiter.take('s1:resize')).toBe(0);
    expect(limiter.take('s2:resize')).toBeNull();
  });
});
