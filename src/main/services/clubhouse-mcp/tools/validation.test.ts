import { describe, it, expect } from 'vitest';
import {
  McpArgError,
  requireString,
  optionalString,
  stringWithDefault,
  requireNumber,
  optionalNumber,
  numberWithDefault,
  requireBoolean,
  optionalBoolean,
  booleanWithDefault,
} from './validation';

describe('MCP tool argument validation', () => {
  describe('requireString', () => {
    it('returns the string value when present', () => {
      expect(requireString({ name: 'hello' }, 'name')).toBe('hello');
    });

    it('allows empty string', () => {
      expect(requireString({ name: '' }, 'name')).toBe('');
    });

    it('throws McpArgError for missing key', () => {
      expect(() => requireString({}, 'name')).toThrow(McpArgError);
      expect(() => requireString({}, 'name')).toThrow(/name must be a string/);
    });

    it('throws McpArgError for null', () => {
      expect(() => requireString({ name: null }, 'name')).toThrow(/got null/);
    });

    it('throws McpArgError for number', () => {
      expect(() => requireString({ name: 42 }, 'name')).toThrow(/got number/);
    });

    it('throws McpArgError for object', () => {
      expect(() => requireString({ name: {} }, 'name')).toThrow(/got object/);
    });

    it('throws McpArgError for boolean', () => {
      expect(() => requireString({ name: true }, 'name')).toThrow(/got boolean/);
    });
  });

  describe('optionalString', () => {
    it('returns the string value when present', () => {
      expect(optionalString({ name: 'hello' }, 'name')).toBe('hello');
    });

    it('returns undefined for missing key', () => {
      expect(optionalString({}, 'name')).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(optionalString({ name: null }, 'name')).toBeUndefined();
    });

    it('throws McpArgError for number', () => {
      expect(() => optionalString({ name: 42 }, 'name')).toThrow(McpArgError);
    });
  });

  describe('stringWithDefault', () => {
    it('returns the string value when present', () => {
      expect(stringWithDefault({ color: 'red' }, 'color', 'blue')).toBe('red');
    });

    it('returns default for missing key', () => {
      expect(stringWithDefault({}, 'color', 'blue')).toBe('blue');
    });

    it('returns default for null', () => {
      expect(stringWithDefault({ color: null }, 'color', 'blue')).toBe('blue');
    });

    it('throws McpArgError for wrong type', () => {
      expect(() => stringWithDefault({ color: 123 }, 'color', 'blue')).toThrow(McpArgError);
    });
  });

  describe('requireNumber', () => {
    it('returns the number value when present', () => {
      expect(requireNumber({ count: 5 }, 'count')).toBe(5);
    });

    it('allows zero', () => {
      expect(requireNumber({ count: 0 }, 'count')).toBe(0);
    });

    it('throws McpArgError for string', () => {
      expect(() => requireNumber({ count: '5' }, 'count')).toThrow(/got string/);
    });

    it('throws McpArgError for NaN', () => {
      expect(() => requireNumber({ count: NaN }, 'count')).toThrow(/must be a finite number/);
    });

    it('throws McpArgError for Infinity', () => {
      expect(() => requireNumber({ count: Infinity }, 'count')).toThrow(/must be a finite number/);
    });
  });

  describe('optionalNumber', () => {
    it('returns the number when present', () => {
      expect(optionalNumber({ limit: 10 }, 'limit')).toBe(10);
    });

    it('returns undefined for missing', () => {
      expect(optionalNumber({}, 'limit')).toBeUndefined();
    });

    it('throws for string value', () => {
      expect(() => optionalNumber({ limit: '10' }, 'limit')).toThrow(McpArgError);
    });
  });

  describe('numberWithDefault', () => {
    it('returns the number when present', () => {
      expect(numberWithDefault({ depth: 3 }, 'depth', 5)).toBe(3);
    });

    it('returns default for missing', () => {
      expect(numberWithDefault({}, 'depth', 5)).toBe(5);
    });

    it('throws for wrong type', () => {
      expect(() => numberWithDefault({ depth: 'deep' }, 'depth', 5)).toThrow(McpArgError);
    });
  });

  describe('requireBoolean', () => {
    it('returns true when true', () => {
      expect(requireBoolean({ flag: true }, 'flag')).toBe(true);
    });

    it('returns false when false', () => {
      expect(requireBoolean({ flag: false }, 'flag')).toBe(false);
    });

    it('throws for string "true"', () => {
      expect(() => requireBoolean({ flag: 'true' }, 'flag')).toThrow(/got string/);
    });

    it('throws for number 1', () => {
      expect(() => requireBoolean({ flag: 1 }, 'flag')).toThrow(/got number/);
    });
  });

  describe('optionalBoolean', () => {
    it('returns the boolean when present', () => {
      expect(optionalBoolean({ flag: false }, 'flag')).toBe(false);
    });

    it('returns undefined for missing', () => {
      expect(optionalBoolean({}, 'flag')).toBeUndefined();
    });

    it('throws for wrong type', () => {
      expect(() => optionalBoolean({ flag: 0 }, 'flag')).toThrow(McpArgError);
    });
  });

  describe('booleanWithDefault', () => {
    it('returns the boolean when present', () => {
      expect(booleanWithDefault({ flag: true }, 'flag', false)).toBe(true);
    });

    it('returns default for missing', () => {
      expect(booleanWithDefault({}, 'flag', false)).toBe(false);
    });

    it('throws for wrong type', () => {
      expect(() => booleanWithDefault({ flag: 'yes' }, 'flag', false)).toThrow(McpArgError);
    });
  });
});
