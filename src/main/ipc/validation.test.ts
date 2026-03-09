import { describe, it, expect } from 'vitest';
import { stringArg } from './validation';

describe('stringArg', () => {
  it('rejects non-string values', () => {
    const validator = stringArg();
    expect(() => validator(123, 'test')).toThrow('must be a string');
    expect(() => validator(null, 'test')).toThrow('must be a string');
  });

  it('enforces minLength', () => {
    const validator = stringArg({ minLength: 3 });
    expect(() => validator('ab', 'test')).toThrow('must be at least 3 characters');
    expect(validator('abc', 'test')).toBe('abc');
  });

  it('enforces maxLength', () => {
    const validator = stringArg({ minLength: 0, maxLength: 10 });
    expect(() => validator('x'.repeat(11), 'test')).toThrow('must be at most 10 characters');
    expect(validator('x'.repeat(10), 'test')).toBe('x'.repeat(10));
  });

  it('allows empty string when minLength is 0', () => {
    const validator = stringArg({ minLength: 0 });
    expect(validator('', 'test')).toBe('');
  });

  it('maxLength and minLength work together', () => {
    const validator = stringArg({ minLength: 2, maxLength: 5 });
    expect(() => validator('a', 'test')).toThrow('must be at least 2');
    expect(() => validator('abcdef', 'test')).toThrow('must be at most 5');
    expect(validator('abc', 'test')).toBe('abc');
  });
});
