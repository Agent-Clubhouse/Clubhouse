import { describe, expect, it } from 'vitest';
import { ANTIGRAVITY_ACP_LOG_GLOB, antigravityDiagnosticFacts, homeRelativePath, plainCliVersion } from './antigravity-diagnostics';

describe('Antigravity local diagnostic facts (#3800)', () => {
  it('reads a plain version out of agy output and nothing else', () => {
    expect(plainCliVersion('agy 1.5.13')).toBe('1.5.13');
    expect(plainCliVersion('Antigravity CLI v1.5.13-beta.2 (build abc)')).toBe('1.5.13-beta.2');
    expect(plainCliVersion('no version here')).toBeUndefined();
    expect(plainCliVersion(undefined)).toBeUndefined();
    // Text around the version, including a user name or a path, is not kept.
    expect(plainCliVersion('/Users/somebody/.local/bin/agy 1.5.13 token=sk-abc')).toBe('1.5.13');
  });

  it('writes paths home-relative on every platform, never the home folder name', () => {
    expect(homeRelativePath('/Users/somebody/.clubhouse/logs/agy-acp.log', '/Users/somebody', 'darwin')).toBe('~/.clubhouse/logs/agy-acp.log');
    expect(homeRelativePath('C:\\Users\\Somebody\\AppData\\Roaming\\Clubhouse\\logs\\agy-acp.log', 'c:\\users\\somebody', 'win32')).toBe('~/AppData/Roaming/Clubhouse/logs/agy-acp.log');
    expect(homeRelativePath('/home/somebody/.config/Clubhouse/logs/a.log', '/home/somebody/', 'linux')).toBe('~/.config/Clubhouse/logs/a.log');
  });

  it('keeps only the file name for a path outside the home folder, and never matches a sibling prefix', () => {
    expect(homeRelativePath('/var/folders/zz/T/acp.log', '/Users/somebody', 'darwin')).toBe('<elsewhere>/acp.log');
    expect(homeRelativePath('/Users/somebody2/acp.log', '/Users/somebody', 'darwin')).toBe('<elsewhere>/acp.log');
    expect(homeRelativePath('/data/x/acp.log', '', 'linux')).toBe('<elsewhere>/acp.log');
  });

  it('is case-sensitive on Linux', () => {
    expect(homeRelativePath('/home/Somebody/a.log', '/home/somebody', 'linux')).toBe('<elsewhere>/a.log');
  });

  it('assembles the facts: version, Antigravity\'s documented glob, and Clubhouse\'s log file', () => {
    const facts = antigravityDiagnosticFacts({ cliVersionOutput: 'agy 1.5.13', clubhouseLogFile: '/Users/somebody/Library/Logs/Clubhouse/agy-acp-1.log', home: '/Users/somebody', platform: 'darwin' });
    expect(facts).toEqual({ cliVersion: '1.5.13', acpLogGlob: '~/.gemini/antigravity-cli/log/acp-*.log', clubhouseLogFile: '~/Library/Logs/Clubhouse/agy-acp-1.log' });
    expect(JSON.stringify(facts)).not.toContain('somebody');
    expect(facts.acpLogGlob).toBe(ANTIGRAVITY_ACP_LOG_GLOB);
  });

  it('leaves out what it was not given', () => {
    expect(antigravityDiagnosticFacts({ home: '/h' })).toEqual({ acpLogGlob: ANTIGRAVITY_ACP_LOG_GLOB });
  });
});
