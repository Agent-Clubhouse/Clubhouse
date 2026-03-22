import { describe, it, expect } from 'vitest';
import { isAllowedNavigation } from './index';

describe('isAllowedNavigation', () => {
  it('allows file:// URLs', () => {
    expect(isAllowedNavigation('file:///Users/test/app/index.html')).toBe(true);
  });

  it('allows localhost URLs', () => {
    expect(isAllowedNavigation('http://localhost:3000')).toBe(true);
    expect(isAllowedNavigation('http://localhost:8080/path')).toBe(true);
  });

  it('allows 127.0.0.1 URLs', () => {
    expect(isAllowedNavigation('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedNavigation('https://127.0.0.1:5173')).toBe(true);
  });

  it('blocks external HTTP URLs', () => {
    expect(isAllowedNavigation('https://evil.com')).toBe(false);
    expect(isAllowedNavigation('http://attacker.io/steal')).toBe(false);
  });

  it('blocks external HTTPS URLs', () => {
    expect(isAllowedNavigation('https://google.com')).toBe(false);
    expect(isAllowedNavigation('https://cdn.example.com/script.js')).toBe(false);
  });

  it('blocks javascript: URLs', () => {
    expect(isAllowedNavigation('javascript:alert(1)')).toBe(false);
  });

  it('blocks data: URLs', () => {
    expect(isAllowedNavigation('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('blocks blob: URLs', () => {
    expect(isAllowedNavigation('blob:https://evil.com/abc-123')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isAllowedNavigation('')).toBe(false);
    expect(isAllowedNavigation('not a url')).toBe(false);
  });
});
