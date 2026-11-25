import { describe, it, expect } from 'vitest';
import { documentUrl, isAllowedNavigation, isOpenExternalAllowed } from './navigation-guard';

const PACKAGED = 'file:///Applications/Clubhouse.app/Contents/Resources/app.asar/.webpack/renderer/main_window/index.html';
const WINDOWS = 'file:///C:/Program%20Files/Clubhouse/resources/app.asar/.webpack/renderer/main_window/index.html';
const DEV = 'http://localhost:3456/main_window/index.html';

describe('isAllowedNavigation (#3881)', () => {
  describe('packaged build (file:// entry)', () => {
    it('allows the app entry itself, with any query or hash', () => {
      expect(isAllowedNavigation(PACKAGED, PACKAGED)).toBe(true);
      expect(isAllowedNavigation(`${PACKAGED}?popout=1#/agents`, PACKAGED)).toBe(true);
    });

    it('allows the Windows entry spelled with a different drive-letter case or escaping', () => {
      expect(isAllowedNavigation('file:///c:/Program Files/Clubhouse/resources/app.asar/.webpack/renderer/main_window/index.html', WINDOWS)).toBe(true);
    });

    it.each([
      'file:///Users/someone/Downloads/dropped.html',
      'file:///Users/someone/Downloads/notes.txt',
      'file:///Applications/Clubhouse.app/Contents/Resources/app.asar/.webpack/renderer/main_window/other.html',
      'file:///etc/hosts',
    ])('blocks another local file: %s', (url) => {
      expect(isAllowedNavigation(url, PACKAGED)).toBe(false);
    });

    it.each(['http://localhost:3000', 'http://127.0.0.1:3456/main_window/index.html', 'http://[::1]:8080/'])('blocks localhost %s', (url) => {
      expect(isAllowedNavigation(url, PACKAGED)).toBe(false);
    });
  });

  describe('dev build (dev-server entry)', () => {
    it('allows only the exact dev-server origin', () => {
      expect(isAllowedNavigation(DEV, DEV)).toBe(true);
      expect(isAllowedNavigation('http://localhost:3456/main_window/index.html?x=1#/home', DEV)).toBe(true);
    });

    it.each([
      'http://localhost:3000/',
      'http://127.0.0.1:3456/main_window/index.html',
      'https://localhost:3456/main_window/index.html',
      'file:///Users/someone/Downloads/dropped.html',
    ])('blocks %s', (url) => {
      expect(isAllowedNavigation(url, DEV)).toBe(false);
    });
  });

  it.each([
    'https://evil.com',
    'http://attacker.io/steal',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://evil.com/abc-123',
    '',
    'not a url',
  ])('blocks %s for any entry', (url) => {
    expect(isAllowedNavigation(url, PACKAGED)).toBe(false);
    expect(isAllowedNavigation(url, DEV)).toBe(false);
  });

  it('blocks everything when the entry does not parse', () => {
    expect(isAllowedNavigation(PACKAGED, '')).toBe(false);
  });
});

describe('documentUrl', () => {
  it('drops query and hash', () => {
    expect(documentUrl('file:///a/b.html?x#y')).toBe('file:///a/b.html');
  });
  it('returns empty for junk', () => {
    expect(documentUrl('nope')).toBe('');
  });
});

describe('isOpenExternalAllowed', () => {
  it.each(['https://example.com', 'http://example.com', 'mailto:a@example.com'])('allows %s', (url) => {
    expect(isOpenExternalAllowed(url)).toBe(true);
  });
  it.each(['file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,x', 'not a url'])('blocks %s', (url) => {
    expect(isOpenExternalAllowed(url)).toBe(false);
  });
});
