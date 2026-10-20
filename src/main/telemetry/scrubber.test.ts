import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { createScrubber, sanitizeStack } from './scrubber';

const scrub = createScrubber({ homeDir: '/Users/alice', username: 'alice', hostname: 'alices-mbp' });

describe('scrubber', () => {
  it.each([
    ['/Users/alice/projects/secret-repo/src/index.ts', '<home><path>'],
    ['open /var/folders/xy/T/clubhouse-123 failed', 'open <path> failed'],
    ['see ~/code/thing.md', 'see <path>'],
    ['https://github.com/acme/private-repo.git', '<url>'],
    ['file:///Users/alice/a.txt', '<url>'],
    ['token at wss://192.168.1.4:8443/annex?token=abc', 'token at <url>'],
    ['mail alice@example.com now', 'mail <email> now'],
    ['peer 192.168.1.20 refused', 'peer <ip> refused'],
    ['bound to ::1 and fe80::1ff:fe23:4567:890a', 'bound to <ip> and <ip>'],
    ['host alices-mbp.local responded', 'host <host>.local responded'],
    ['user alice logged in', 'user <user> logged in'],
  ])('scrubs %j', (input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it.each([
    'Clubhouse 0.43.0-beta.2',
    'Electron 43.0.1',
    'node v22.11.0',
    'std::vector',
    '12:30:45',
    'durable',
    'binary_not_found',
    '<1MB',
  ])('leaves %j untouched', (input) => {
    expect(scrub(input)).toBe(input);
  });

  it.each([
    ['C:\\Users\\Alice\\AppData\\Roaming\\Clubhouse\\settings.json'],
    ['c:/Users/Alice/source/repo'],
    ['"C:\\\\Users\\\\Alice\\\\repo"'],
    ['\\\\fileserver\\share\\team\\repo'],
    ['\\\\?\\C:\\very\\long\\path'],
    ['\\\\.\\pipe\\clubhouse-hooks'],
  ])('scrubs Windows path %j', (input) => {
    const out = scrub(input);
    expect(out).toContain('<path>');
    expect(out).not.toMatch(/Alice|fileserver|clubhouse-hooks|very/);
  });

  it('scrubs the real home directory of the machine running the tests', () => {
    // On the Windows runner this is a real C:\Users\... value (spec §5.3).
    const home = os.homedir();
    const live = createScrubber({ homeDir: home, username: os.userInfo().username, hostname: os.hostname() });
    const nested = path.join(home, 'source', 'Clubhouse', 'notes.md');
    expect(live(`failed to read ${nested}`)).not.toContain(home);
    expect(live(JSON.stringify({ p: nested }))).not.toContain(path.basename(home) + path.sep + 'source');
    expect(live(`cwd=${home}`)).toBe('cwd=<home>');
  });

  it('scrubs the rest of a Windows path after the home directory', () => {
    const s = createScrubber({ homeDir: 'C:\\Users\\alice', username: 'alice', hostname: 'DESKTOP-ABC123' });
    expect(s('failed to read C:\\Users\\alice\\projects\\secret-repo\\src\\index.ts')).toBe('failed to read <home><path>');
    expect(s('c:\\users\\ALICE\\projects\\secret-repo')).toBe('<home><path>');
    const linux = createScrubber({ homeDir: '/home/alice', username: 'alice' });
    expect(linux('failed to read /home/alice/projects/secret-repo')).toBe('failed to read <home><path>');
  });

  it('does not scrub very short usernames out of ordinary words', () => {
    const s = createScrubber({ username: 'al', homeDir: '/home/al' });
    expect(s('totally normal')).toBe('totally normal');
  });
});

describe('sanitizeStack', () => {
  it('drops the message line and keeps only basenames of frames', () => {
    const err = new Error('failed to open /Users/alice/secret/file.txt for alice@example.com');
    err.stack = [
      'Error: failed to open /Users/alice/secret/file.txt for alice@example.com',
      '    at readConfig (/Users/alice/app/dist/main/index.js:120:15)',
      '    at C:\\Users\\Alice\\app\\resources\\app.asar\\.webpack\\main\\index.js:9:3',
      '    at async Promise.all (index 0)',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n');
    const out = sanitizeStack(err.stack, scrub) ?? '';
    expect(out).not.toMatch(/alice|Alice|secret|example\.com|failed to open/);
    expect(out).toContain('at readConfig (index.js:120:15)');
    expect(out).toContain('at index.js:9:3');
  });

  it('returns undefined for missing or frameless stacks', () => {
    expect(sanitizeStack(undefined, scrub)).toBeUndefined();
    expect(sanitizeStack('just a message', scrub)).toBeUndefined();
  });
});
