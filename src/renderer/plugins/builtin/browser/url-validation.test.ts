import { describe, it, expect } from 'vitest';
import { validateUrl, normalizeAddress } from './url-validation';
import type { ProtocolSettings } from './url-validation';

// ── validateUrl ──────────────────────────────────────────────────────────

describe('validateUrl', () => {
  const defaultSettings: ProtocolSettings = {
    allowLocalhost: false,
    allowFileProtocol: false,
  };

  const allEnabled: ProtocolSettings = {
    allowLocalhost: true,
    allowFileProtocol: true,
  };

  // ── HTTPS (always allowed) ────────────────────────────────────────

  describe('HTTPS', () => {
    it('allows https:// URLs with default settings', () => {
      expect(validateUrl('https://example.com', defaultSettings)).toEqual({ valid: true });
    });

    it('allows https:// with path', () => {
      expect(validateUrl('https://example.com/path?q=1', defaultSettings)).toEqual({ valid: true });
    });

    it('allows https:// with port', () => {
      expect(validateUrl('https://example.com:8443', defaultSettings)).toEqual({ valid: true });
    });
  });

  // ── HTTP localhost ────────────────────────────────────────────────

  describe('HTTP localhost', () => {
    it('blocks http://localhost when allowLocalhost is false', () => {
      const result = validateUrl('http://localhost:3000', defaultSettings);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Allow localhost');
    });

    it('allows http://localhost when allowLocalhost is true', () => {
      expect(validateUrl('http://localhost:3000', allEnabled)).toEqual({ valid: true });
    });

    it('blocks http://127.0.0.1 when allowLocalhost is false', () => {
      const result = validateUrl('http://127.0.0.1:8080', defaultSettings);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Allow localhost');
    });

    it('allows http://127.0.0.1 when allowLocalhost is true', () => {
      expect(validateUrl('http://127.0.0.1:8080', allEnabled)).toEqual({ valid: true });
    });

    it('allows http://[::1] when allowLocalhost is true', () => {
      expect(validateUrl('http://[::1]:3000', allEnabled)).toEqual({ valid: true });
    });

    it('blocks http://[::1] when allowLocalhost is false', () => {
      const result = validateUrl('http://[::1]:3000', defaultSettings);
      expect(result.valid).toBe(false);
    });
  });

  // ── HTTP non-localhost ────────────────────────────────────────────

  describe('HTTP non-localhost', () => {
    it('blocks http:// to remote hosts', () => {
      const result = validateUrl('http://example.com', defaultSettings);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('HTTPS');
    });

    it('blocks http:// to remote hosts even with all settings enabled', () => {
      const result = validateUrl('http://example.com', allEnabled);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('HTTPS');
    });
  });

  // ── file:// ───────────────────────────────────────────────────────

  describe('file:// protocol', () => {
    it('blocks file:// when allowFileProtocol is false', () => {
      const result = validateUrl('file:///Users/test/index.html', defaultSettings);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Allow file://');
    });

    it('allows file:// when allowFileProtocol is true', () => {
      expect(validateUrl('file:///Users/test/index.html', allEnabled)).toEqual({ valid: true });
    });

    it('blocks file:// even if allowLocalhost is true but allowFileProtocol is false', () => {
      const result = validateUrl('file:///tmp/test.html', { allowLocalhost: true, allowFileProtocol: false });
      expect(result.valid).toBe(false);
    });
  });

  // ── Unsupported protocols ─────────────────────────────────────────

  describe('unsupported protocols', () => {
    it('blocks ftp://', () => {
      const result = validateUrl('ftp://example.com', allEnabled);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported protocol');
    });

    it('blocks data: URLs', () => {
      const result = validateUrl('data:text/html,<h1>hi</h1>', allEnabled);
      expect(result.valid).toBe(false);
    });

    it('blocks javascript: URLs', () => {
      const result = validateUrl('javascript:alert(1)', allEnabled);
      expect(result.valid).toBe(false);
    });
  });

  // ── Invalid input ─────────────────────────────────────────────────

  describe('invalid input', () => {
    it('rejects empty string', () => {
      const result = validateUrl('', defaultSettings);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid URL');
    });

    it('rejects garbage input', () => {
      const result = validateUrl('not a url at all!!!', defaultSettings);
      expect(result.valid).toBe(false);
    });
  });
});

// ── normalizeAddress ─────────────────────────────────────────────────────

describe('normalizeAddress', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeAddress('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeAddress('   ')).toBe('');
  });

  it('passes through https:// URLs unchanged', () => {
    expect(normalizeAddress('https://example.com')).toBe('https://example.com');
  });

  it('passes through http:// URLs unchanged', () => {
    expect(normalizeAddress('http://example.com')).toBe('http://example.com');
  });

  it('passes through file:// URLs unchanged', () => {
    expect(normalizeAddress('file:///tmp/test.html')).toBe('file:///tmp/test.html');
  });

  it('prepends https:// for bare domains', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com');
  });

  it('prepends https:// for domains with paths', () => {
    expect(normalizeAddress('example.com/path')).toBe('https://example.com/path');
  });

  it('prepends http:// for localhost', () => {
    expect(normalizeAddress('localhost:3000')).toBe('http://localhost:3000');
  });

  it('prepends http:// for localhost with path', () => {
    expect(normalizeAddress('localhost:3000/api')).toBe('http://localhost:3000/api');
  });

  it('prepends http:// for 127.0.0.1', () => {
    expect(normalizeAddress('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('prepends http:// for 127.0.0.1 without port', () => {
    expect(normalizeAddress('127.0.0.1')).toBe('http://127.0.0.1');
  });

  it('trims whitespace', () => {
    expect(normalizeAddress('  https://example.com  ')).toBe('https://example.com');
  });

  it('handles file: without double slash', () => {
    expect(normalizeAddress('file:/path/to/file')).toBe('file:/path/to/file');
  });
});
