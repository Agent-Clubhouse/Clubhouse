import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const SEP = path.delimiter; // ':' on Unix, ';' on Windows

// Must vi.mock fs at top level for ESM compat
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  unlinkSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found'); }),
  execFileSync: vi.fn(() => { throw new Error('not found'); }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
  open: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: `/usr/local/bin${path.delimiter}/usr/bin` })),
}));

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { execSync, execFileSync } from 'child_process';
import { app } from 'electron';
import { findBinaryInPath, testBinaryOverride, homePath, humanizeModelId, parseModelChoicesFromHelp, buildSummaryInstruction, readQuickSummary, applyLaunchWrapper, validateHookUrl, buildHookCurlCommand, mergeHookEntries, resolveEncodedPathDir, parseJsonlFile, validateWrapperConfig, clearBinaryCache } from './shared';
import type { LaunchWrapperConfig } from '../../shared/types';
import type { TranscriptReadStats } from './types';

describe('shared orchestrator utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
  });

  describe('testBinaryOverride (CLUBHOUSE_TEST_CLI_BINARIES)', () => {
    const fake = path.join(os.tmpdir(), 'fake-bin', 'claude');
    afterEach(() => {
      delete process.env.CLUBHOUSE_TEST_CLI_BINARIES;
      (app as { isPackaged: boolean }).isPackaged = false;
    });

    it('is undefined when the variable is unset or the provider is not listed', () => {
      expect(testBinaryOverride('claude-code')).toBeUndefined();
      process.env.CLUBHOUSE_TEST_CLI_BINARIES = JSON.stringify({ 'codex-cli': fake });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(testBinaryOverride('claude-code')).toBeUndefined();
    });

    it('returns the listed binary when it exists', () => {
      process.env.CLUBHOUSE_TEST_CLI_BINARIES = JSON.stringify({ 'claude-code': fake });
      vi.mocked(fs.existsSync).mockImplementation((p) => p === fake);
      expect(testBinaryOverride('claude-code')).toBe(fake);
    });

    it('throws instead of falling back when the listed binary is missing', () => {
      process.env.CLUBHOUSE_TEST_CLI_BINARIES = JSON.stringify({ 'claude-code': fake });
      expect(() => testBinaryOverride('claude-code')).toThrow(/Could not find the claude-code test binary/);
    });

    it('throws on malformed JSON', () => {
      process.env.CLUBHOUSE_TEST_CLI_BINARIES = '{nope';
      expect(() => testBinaryOverride('claude-code')).toThrow(/not valid JSON/);
    });

    it('is ignored in packaged builds', () => {
      process.env.CLUBHOUSE_TEST_CLI_BINARIES = JSON.stringify({ 'claude-code': fake });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (app as { isPackaged: boolean }).isPackaged = true;
      expect(testBinaryOverride('claude-code')).toBeUndefined();
    });
  });

  describe('findBinaryInPath', () => {
    it('finds binary via where/which (shell-native lookup)', () => {
      const shellResult = process.platform === 'win32'
        ? 'C:\\Program Files\\cli\\claude.exe\r\n'
        : '/usr/local/bin/claude\n';
      const expected = shellResult.trim().split(/\r?\n/)[0].trim();
      if (process.platform === 'win32') {
        vi.mocked(execSync).mockReturnValue(shellResult);
      } else {
        vi.mocked(execFileSync).mockReturnValue(shellResult);
      }
      vi.mocked(fs.existsSync).mockImplementation((p) => p === expected);
      const result = findBinaryInPath(['claude'], []);
      expect(result).toBe(expected);
    });

    it('handles multi-line shell output (startup messages before path)', () => {
      if (process.platform === 'win32') return; // Unix-only test
      // Simulates shell startup messages (e.g., nvm loading) appearing before `which` output
      const shellOutput = 'Loading nvm...\nnvm loaded\n/home/user/.nvm/versions/node/v20/bin/codex\n';
      vi.mocked(execFileSync).mockReturnValue(shellOutput);
      vi.mocked(fs.existsSync).mockImplementation(
        (p) => p === '/home/user/.nvm/versions/node/v20/bin/codex',
      );
      const result = findBinaryInPath(['codex'], []);
      expect(result).toBe('/home/user/.nvm/versions/node/v20/bin/codex');
    });

    it('falls back to PATH scan when where/which fails', () => {
      const expected = path.join('/usr/local/bin', 'claude');
      vi.mocked(fs.existsSync).mockImplementation((p) => p === expected);
      // execSync throws by default (where/which fails)
      const result = findBinaryInPath(['claude'], ['/nonexistent/claude']);
      expect(result).toBe(expected);
    });

    it('tries multiple binary names on PATH', () => {
      const expected = path.join('/usr/bin', 'code');
      vi.mocked(fs.existsSync).mockImplementation((p) => p === expected);
      const result = findBinaryInPath(['claude', 'code'], ['/nope/claude']);
      expect(result).toBe(expected);
    });

    it('skips empty PATH entries', async () => {
      const shell = await import('../util/shell');
      vi.mocked(shell.getShellEnvironment).mockReturnValue({ PATH: `${SEP}/usr/bin${SEP}` } as any);
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return p === path.join('/usr/bin', 'claude');
      });
      const result = findBinaryInPath(['claude'], []);
      expect(result).toBe(path.join('/usr/bin', 'claude'));
    });

    it('falls back to extraPaths when PATH has no match', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => p === '/custom/path/claude');
      const result = findBinaryInPath(['claude'], ['/custom/path/claude']);
      expect(result).toBe('/custom/path/claude');
    });

    it('checks extraPaths in order, returns first hit', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return p === '/second/claude';
      });
      const result = findBinaryInPath(['claude'], ['/first/claude', '/second/claude']);
      expect(result).toBe('/second/claude');
    });

    it('throws when binary not found anywhere', () => {
      expect(() => findBinaryInPath(['claude'], []))
        .toThrowError(/Could not find any of \[claude\] on PATH/);
    });

    it('handles \\r\\n line endings from where on Windows', () => {
      if (process.platform !== 'win32') return; // where output format is Windows-only
      // Windows `where` outputs results with \r\n
      vi.mocked(execSync).mockReturnValue('C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\another\\claude.cmd\r\n');
      vi.mocked(fs.existsSync).mockImplementation((p) => p === 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd');
      const result = findBinaryInPath(['claude'], []);
      expect(result).toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd');
    });

    it('prioritizes extraPaths over PATH scan and where/which', () => {
      const whereResult = '/found/by/where/claude';
      const pathResult = path.join('/usr/local/bin', 'claude');
      vi.mocked(execSync).mockReturnValue(whereResult + '\n');
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return p === whereResult || p === pathResult || p === '/extra/claude';
      });
      const result = findBinaryInPath(['claude'], ['/extra/claude']);
      // extraPaths are checked first (instant fs check, no shell spawn)
      expect(result).toBe('/extra/claude');
    });

    it('falls through all stages in order when earlier stages miss', () => {
      // where/which fails (default mock), PATH has no match, extraPath works
      vi.mocked(fs.existsSync).mockImplementation((p) => p === '/fallback/claude');
      const result = findBinaryInPath(['claude'], ['/fallback/claude']);
      expect(result).toBe('/fallback/claude');
    });
  });

  describe('humanizeModelId', () => {
    it('capitalizes hyphen-separated words', () => {
      expect(humanizeModelId('claude-sonnet-4.5')).toBe('Claude Sonnet 4.5');
    });

    it('strips provider prefix before slash', () => {
      expect(humanizeModelId('github-copilot/gpt-5')).toBe('Gpt 5');
    });

    it('handles single-word id', () => {
      expect(humanizeModelId('default')).toBe('Default');
    });

    it('returns input unchanged when no hyphens or prefix', () => {
      expect(humanizeModelId('gpt5')).toBe('Gpt5');
    });
  });

  describe('applyLaunchWrapper', () => {
    const wrapperConfig: LaunchWrapperConfig = {
      binary: 'mywrapper',
      separator: '--',
      orchestratorMap: {
        'claude-code': { subcommand: 'claude' },
        'copilot-cli': { subcommand: 'copilot' },
      },
    };

    it('transforms binary and inserts subcommand + mcps + separator + original args', () => {
      const result = applyLaunchWrapper(
        wrapperConfig, 'claude-code', 'claude', ['--model', 'opus', 'do the thing'], ['ado', 'kusto']
      );
      expect(result).toEqual({
        binary: 'mywrapper',
        args: ['claude', '--mcp', 'ado', '--mcp', 'kusto', '--', '--model', 'opus', 'do the thing'],
      });
    });

    it('works with no MCPs selected', () => {
      const result = applyLaunchWrapper(
        wrapperConfig, 'claude-code', 'claude', ['--model', 'opus'], []
      );
      expect(result).toEqual({
        binary: 'mywrapper',
        args: ['claude', '--', '--model', 'opus'],
      });
    });

    it('works with no original args', () => {
      const result = applyLaunchWrapper(
        wrapperConfig, 'claude-code', 'claude', [], ['ado']
      );
      expect(result).toEqual({
        binary: 'mywrapper',
        args: ['claude', '--mcp', 'ado', '--'],
      });
    });

    it('maps different orchestrator IDs to correct subcommands', () => {
      const result = applyLaunchWrapper(
        wrapperConfig, 'copilot-cli', 'copilot', ['--help'], ['fs']
      );
      expect(result).toEqual({
        binary: 'mywrapper',
        args: ['copilot', '--mcp', 'fs', '--', '--help'],
      });
    });

    it('throws when orchestrator has no mapping', () => {
      expect(() => applyLaunchWrapper(
        wrapperConfig, 'unknown-cli', 'unknown', [], []
      )).toThrowError(/no mapping for orchestrator "unknown-cli"/);
    });

    it('omits separator when config.separator is empty', () => {
      const noSepConfig: LaunchWrapperConfig = {
        binary: 'wrapper',
        separator: '',
        orchestratorMap: { 'claude-code': { subcommand: 'claude' } },
      };
      const result = applyLaunchWrapper(
        noSepConfig, 'claude-code', 'claude', ['--verbose'], ['ado']
      );
      expect(result).toEqual({
        binary: 'wrapper',
        args: ['claude', '--mcp', 'ado', '--verbose'],
      });
    });

    it('handles multiple MCPs in order', () => {
      const result = applyLaunchWrapper(
        wrapperConfig, 'claude-code', 'claude', [], ['mcp-a', 'mcp-b', 'mcp-c', 'mcp-d']
      );
      expect(result.args).toEqual([
        'claude', '--mcp', 'mcp-a', '--mcp', 'mcp-b', '--mcp', 'mcp-c', '--mcp', 'mcp-d', '--',
      ]);
    });

    it('passes mcpConfigs as args joined with the MCP ID', () => {
      const configs = { 'mcp-a': { '--org': 'myorg' } };
      const result = applyLaunchWrapper(
        wrapperConfig, 'claude-code', 'claude', ['--model', 'opus'], ['mcp-a', 'mcp-b'], configs
      );
      expect(result.args).toEqual([
        'claude', '--mcp', 'mcp-a --org myorg', '--mcp', 'mcp-b', '--', '--model', 'opus',
      ]);
    });

    it('handles boolean flags in mcpConfigs (value "true" emits flag only)', () => {
      const configs = { 'mcp-a': { '--org': 'myorg', '--verbose': 'true' } };
      const result = applyLaunchWrapper(
        wrapperConfig, 'claude-code', 'claude', [], ['mcp-a'], configs
      );
      expect(result.args).toEqual([
        'claude', '--mcp', 'mcp-a --org myorg --verbose', '--',
      ]);
    });

    it('skips empty-string config values', () => {
      const configs = { 'mcp-a': { '--org': '', '--scope': 'read' } };
      const result = applyLaunchWrapper(
        wrapperConfig, 'claude-code', 'claude', [], ['mcp-a'], configs
      );
      expect(result.args).toEqual([
        'claude', '--mcp', 'mcp-a --scope read', '--',
      ]);
    });

    it('passes plain ID when MCP has no config entry', () => {
      const configs = { 'mcp-a': { '--org': 'myorg' } };
      const result = applyLaunchWrapper(
        wrapperConfig, 'claude-code', 'claude', [], ['mcp-a', 'mcp-b'], configs
      );
      expect(result.args[4]).toBe('mcp-b');
    });

    it('works with undefined mcpConfigs (backwards compat)', () => {
      const result = applyLaunchWrapper(
        wrapperConfig, 'claude-code', 'claude', ['--model', 'opus'], ['mcp-a']
      );
      expect(result.args).toEqual(['claude', '--mcp', 'mcp-a', '--', '--model', 'opus']);
    });
  });

  describe('parseModelChoicesFromHelp', () => {
    const COPILOT_PATTERN = /--model\s+<model>\s+.*?\(choices:\s*([\s\S]*?)\)/;
    const CODEX_PATTERN = /--model\s+(?:<\w+>)?\s*.*?\(choices:\s*([\s\S]*?)\)/;

    const COPILOT_HELP = `Usage: copilot [options]

Options:
  --model <model>   Model to use (choices: "gpt-5", "claude-sonnet-4.5",
                    "claude-opus-4.6")
  --help            Show help`;

    const CODEX_HELP = `Usage: codex [options]

Options:
  --model <model>   Model to use (choices: "gpt-5.3-codex", "gpt-5.2-codex",
                    "codex-mini-latest")
  --help            Show help`;

    it('parses model choices from Copilot help output', () => {
      const result = parseModelChoicesFromHelp(COPILOT_HELP, COPILOT_PATTERN);
      expect(result).toEqual([
        { id: 'default', label: 'Default' },
        { id: 'gpt-5', label: 'Gpt 5' },
        { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
        { id: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
      ]);
    });

    it('parses model choices from Codex help output', () => {
      const result = parseModelChoicesFromHelp(CODEX_HELP, CODEX_PATTERN);
      expect(result).toEqual([
        { id: 'default', label: 'Default' },
        { id: 'gpt-5.3-codex', label: 'Gpt 5.3 Codex' },
        { id: 'gpt-5.2-codex', label: 'Gpt 5.2 Codex' },
        { id: 'codex-mini-latest', label: 'Codex Mini Latest' },
      ]);
    });

    it('returns null when pattern does not match', () => {
      expect(parseModelChoicesFromHelp('no model flag here', COPILOT_PATTERN)).toBeNull();
    });

    it('returns null when choices section has no quoted IDs', () => {
      const help = '--model <model>   Model to use (choices: )';
      expect(parseModelChoicesFromHelp(help, COPILOT_PATTERN)).toBeNull();
    });

    it('always prepends a default entry', () => {
      const result = parseModelChoicesFromHelp(COPILOT_HELP, COPILOT_PATTERN);
      expect(result![0]).toEqual({ id: 'default', label: 'Default' });
    });

    it('handles single model in choices', () => {
      const help = '--model <model>   Model to use (choices: "only-one")';
      const result = parseModelChoicesFromHelp(help, COPILOT_PATTERN);
      expect(result).toEqual([
        { id: 'default', label: 'Default' },
        { id: 'only-one', label: 'Only One' },
      ]);
    });
  });

  describe('homePath', () => {
    it('joins segments under home directory', () => {
      const result = homePath('.local', 'bin', 'claude');
      expect(result).toBe(path.join(os.tmpdir(), 'clubhouse-test-home', '.local', 'bin', 'claude'));
    });

    it('works with single segment', () => {
      const result = homePath('.claude');
      expect(result).toBe(path.join(os.tmpdir(), 'clubhouse-test-home', '.claude'));
    });
  });

  describe('buildSummaryInstruction', () => {
    it('includes agentId in file path', () => {
      const result = buildSummaryInstruction('agent-123');
      expect(result).toContain('clubhouse-summary-agent-123.json');
    });

    it('specifies JSON format with summary and filesModified', () => {
      const result = buildSummaryInstruction('test');
      expect(result).toContain('"summary"');
      expect(result).toContain('"filesModified"');
    });
  });

  describe('validateHookUrl', () => {
    it('accepts a plain http localhost URL', () => {
      expect(validateHookUrl('http://localhost:3000/hooks')).toBe('http://localhost:3000/hooks');
    });

    it('accepts https with an IP address', () => {
      expect(validateHookUrl('https://127.0.0.1:8080/hook')).toBe('https://127.0.0.1:8080/hook');
    });

    it('accepts IPv6 bracket notation', () => {
      expect(validateHookUrl('http://[::1]:4000/hooks')).toBe('http://[::1]:4000/hooks');
    });

    it('accepts a URL with no path', () => {
      expect(validateHookUrl('http://localhost:9000')).toBe('http://localhost:9000');
    });

    it('rejects a URL with a semicolon (command separator)', () => {
      expect(() => validateHookUrl('http://localhost:3000/hooks;rm -rf /')).toThrow('disallowed');
    });

    it('rejects a URL with a pipe', () => {
      expect(() => validateHookUrl('http://localhost:3000/hooks|cat /etc/passwd')).toThrow('disallowed');
    });

    it('rejects a URL with an ampersand (shell background)', () => {
      expect(() => validateHookUrl('http://localhost:3000/hook&evil')).toThrow('disallowed');
    });

    it('rejects a URL with a dollar sign (variable expansion)', () => {
      expect(() => validateHookUrl('http://localhost:3000/$(rm -rf /)')).toThrow('disallowed');
    });

    it('rejects a URL with backticks', () => {
      expect(() => validateHookUrl('http://localhost:3000/`whoami`')).toThrow('disallowed');
    });

    it('rejects a URL with a newline', () => {
      expect(() => validateHookUrl('http://localhost:3000/hook\nrm -rf /')).toThrow('disallowed');
    });

    it('rejects a URL with a query string (& in query)', () => {
      expect(() => validateHookUrl('http://localhost:3000/hooks?foo=bar&baz=qux')).toThrow('disallowed');
    });

    it('rejects non-http/https schemes', () => {
      expect(() => validateHookUrl('file:///etc/passwd')).toThrow('disallowed');
    });

    it('rejects a completely invalid URL', () => {
      expect(() => validateHookUrl('not a url')).toThrow('Invalid hook URL');
    });
  });

  describe('readQuickSummary', () => {
    it('reads and parses summary file', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ summary: 'Fixed the bug', filesModified: ['src/app.ts'] })
      );

      const result = await readQuickSummary('agent-1');
      expect(result).toEqual({
        summary: 'Fixed the bug',
        filesModified: ['src/app.ts'],
      });
    });

    it('deletes the file after reading', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ summary: 'Done', filesModified: [] })
      );

      await readQuickSummary('agent-2');
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(os.tmpdir(), 'clubhouse-summary-agent-2.json'));
    });

    it('returns null when file does not exist', async () => {
      const result = await readQuickSummary('missing');
      expect(result).toBeNull();
    });

    it('handles malformed JSON gracefully', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not json');
      const result = await readQuickSummary('bad');
      expect(result).toBeNull();
    });

    it('handles missing summary field', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ filesModified: ['a.ts'] })
      );

      const result = await readQuickSummary('agent-3');
      expect(result).toEqual({ summary: null, filesModified: ['a.ts'] });
    });

    it('handles non-array filesModified', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ summary: 'Done', filesModified: 'not-an-array' })
      );

      const result = await readQuickSummary('agent-4');
      expect(result).toEqual({ summary: 'Done', filesModified: [] });
    });
  });

  describe('buildHookCurlCommand', () => {
    it('builds posix curl command without suffix', () => {
      if (process.platform === 'win32') return;
      const cmd = buildHookCurlCommand('http://localhost:3000/hooks');
      // The port is read from the environment, not baked in: a literal port
      // changes the command on every app launch, which breaks Codex's
      // content-hash hook trust. See buildHookCurlCommand.
      expect(cmd).toContain('http://localhost:${CLUBHOUSE_HOOK_PORT}/hooks/${CLUBHOUSE_AGENT_ID}');
      expect(cmd).not.toContain(':3000');
      expect(cmd).toContain('--data-binary @-');
      expect(cmd).toContain('X-Clubhouse-Nonce');
    });

    it('builds windows curl command with the port as a cmd.exe variable', () => {
      if (process.platform !== 'win32') return;
      const cmd = buildHookCurlCommand('http://localhost:3000/hooks');
      // cmd.exe uses %VAR%, not ${VAR} — the posix assertion above would pass
      // on mac/ubuntu while this branch shipped broken.
      expect(cmd).toContain('http://localhost:%CLUBHOUSE_HOOK_PORT%/hooks/%CLUBHOUSE_AGENT_ID%');
      expect(cmd).not.toContain(':3000');
    });

    it('appends event suffix when provided', () => {
      if (process.platform === 'win32') return;
      const cmd = buildHookCurlCommand('http://localhost:3000/hooks', '/preToolUse');
      expect(cmd).toContain('http://localhost:${CLUBHOUSE_HOOK_PORT}/hooks/${CLUBHOUSE_AGENT_ID}/preToolUse');
    });

    it('produces no suffix when omitted', () => {
      const cmd = buildHookCurlCommand('http://localhost:3000/hooks');
      expect(cmd).not.toContain('/preToolUse');
    });
  });

  describe('mergeHookEntries', () => {
    const isOwn = (e: unknown) => (e as Record<string, unknown>).clubhouse === true;

    it('merges new hooks into empty existing config', () => {
      const result = mergeHookEntries({}, { PreToolUse: [{ type: 'cmd', clubhouse: true }] }, isOwn);
      expect(result).toEqual({ PreToolUse: [{ type: 'cmd', clubhouse: true }] });
    });

    it('preserves user entries and appends ours', () => {
      const existing = { hooks: { PreToolUse: [{ type: 'user-hook' }] } };
      const result = mergeHookEntries(existing, { PreToolUse: [{ type: 'cmd', clubhouse: true }] }, isOwn);
      expect(result.PreToolUse).toEqual([
        { type: 'user-hook' },
        { type: 'cmd', clubhouse: true },
      ]);
    });

    it('replaces stale Clubhouse entries (identified by isOwn)', () => {
      const existing = {
        hooks: { PreToolUse: [{ type: 'old-clubhouse', clubhouse: true }] },
      };
      const result = mergeHookEntries(existing, { PreToolUse: [{ type: 'new-clubhouse', clubhouse: true }] }, isOwn);
      expect(result.PreToolUse).toEqual([{ type: 'new-clubhouse', clubhouse: true }]);
    });

    it('handles multiple event keys', () => {
      const result = mergeHookEntries(
        {},
        {
          PreToolUse: [{ a: 1, clubhouse: true }],
          Stop: [{ b: 2, clubhouse: true }],
        },
        isOwn,
      );
      expect(Object.keys(result)).toEqual(expect.arrayContaining(['PreToolUse', 'Stop']));
    });

    it('does not mutate the existing object', () => {
      const existing = { hooks: { PreToolUse: [{ type: 'user' }] } };
      mergeHookEntries(existing, { PreToolUse: [{ type: 'ours', clubhouse: true }] }, isOwn);
      expect((existing.hooks as Record<string, unknown[]>).PreToolUse).toEqual([{ type: 'user' }]);
    });
  });

  describe('resolveEncodedPathDir', () => {
    it('returns null when base directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(resolveEncodedPathDir('/nonexistent/base', '/some/cwd')).toBeNull();
    });

    it('returns null when no encoded subdir matches', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => p === '/base');
      expect(resolveEncodedPathDir('/base', '/some/project')).toBeNull();
    });

    it('resolves encoded path variant', () => {
      const encoded = path.resolve('/some/project').replace(/[/\\]/g, '-');
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return p === '/base' || p === path.join('/base', encoded) || p === path.join('/base', encoded.replace(/^-/, ''));
      });
      const result = resolveEncodedPathDir('/base', '/some/project');
      const expectedVariant1 = path.join('/base', encoded);
      const expectedVariant2 = path.join('/base', encoded.replace(/^-/, ''));
      expect([expectedVariant1, expectedVariant2]).toContain(result);
    });
  });

  describe('parseJsonlFile', () => {
    it('returns null when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      expect(await parseJsonlFile('/no/such/file.jsonl')).toBeNull();
    });

    it('returns null for empty file', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('');
      expect(await parseJsonlFile('/empty.jsonl')).toBeNull();
    });

    it('parses valid JSONL lines into events', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('{"type":"message","role":"user"}\n{"type":"message","role":"assistant"}\n');
      const result = await parseJsonlFile('/session.jsonl');
      expect(result).toHaveLength(2);
      expect(result![0]).toEqual({ type: 'message', role: 'user' });
      expect(result![1]).toEqual({ type: 'message', role: 'assistant' });
    });

    it('skips malformed JSONL lines and parses valid ones', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('{"type":"ok"}\nnot-json\n{"type":"also-ok"}\n');
      const result = await parseJsonlFile('/mixed.jsonl');
      expect(result).toHaveLength(2);
    });

    it('returns null when all lines are malformed', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('not-json\nalso-not-json\n');
      expect(await parseJsonlFile('/bad.jsonl')).toBeNull();
    });

    describe('with maxBytes (summaries, #2277)', () => {
      /** A file handle over `text` that records the bytes it hands out. */
      function fileOf(text: string) {
        const data = Buffer.from(text, 'utf-8');
        const handle = {
          bytesRead: 0,
          stat: async () => ({ size: data.length }),
          read: async (buf: Buffer, off: number, len: number, pos: number) => {
            const n = data.copy(buf, off, pos, Math.min(pos + len, data.length));
            handle.bytesRead += n;
            return { bytesRead: n, buffer: buf };
          },
          close: vi.fn(async () => undefined),
        };
        vi.mocked(fsp.open).mockResolvedValue(handle as never);
        return handle;
      }
      const line = (i: number) => JSON.stringify({ type: 'message', i, pad: 'x'.repeat(80) });

      it('reads a small file whole', async () => {
        fileOf(`${line(1)}\n${line(2)}\n`);
        const stats: TranscriptReadStats = {};
        expect(await parseJsonlFile('/s.jsonl', { maxBytes: 10_000, stats })).toHaveLength(2);
        expect(stats.truncated).toBeUndefined();
        expect(fsp.readFile).not.toHaveBeenCalled();
      });

      it('reads only the head and tail of a large file, as whole lines', async () => {
        const lines = Array.from({ length: 5000 }, (_, i) => line(i));
        const handle = fileOf(`${lines.join('\n')}\n`);
        const stats: TranscriptReadStats = {};
        const events = await parseJsonlFile('/big.jsonl', { maxBytes: 8192, stats });

        expect(handle.bytesRead).toBeLessThanOrEqual(8192);
        expect(stats).toMatchObject({ truncated: true, bytesRead: handle.bytesRead });
        expect(stats.fileBytes).toBeGreaterThan(400_000);
        const ids = events!.map((e) => (e as unknown as { i: number }).i);
        expect(ids[0]).toBe(0);
        expect(ids[ids.length - 1]).toBe(4999);
        expect(ids.length).toBeLessThan(100);
        expect(handle.close).toHaveBeenCalled();
      });

      it('returns null rather than the head alone when the last line outgrows the tail', async () => {
        fileOf(`${line(0)}\n${line(1)}\n${JSON.stringify({ type: 'result', pad: 'y'.repeat(20_000) })}\n`);
        expect(await parseJsonlFile('/huge-tail.jsonl', { maxBytes: 8192 })).toBeNull();
      });

      it('cuts cleanly around multibyte text', async () => {
        const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: 'message', i, text: 'é漢🙂'.repeat(20) }));
        fileOf(`${lines.join('\n')}\n`);
        const events = await parseJsonlFile('/utf8.jsonl', { maxBytes: 8192 });
        expect(events!.every((e) => (e as unknown as { text: string }).text === 'é漢🙂'.repeat(20))).toBe(true);
        expect((events![events!.length - 1] as unknown as { i: number }).i).toBe(1999);
      });
    });
  });

  describe('validateWrapperConfig', () => {
    const cfg: LaunchWrapperConfig = {
      binary: 'node',
      separator: '--',
      orchestratorMap: { 'claude-code': { subcommand: 'claude' } },
    };

    beforeEach(() => {
      clearBinaryCache();
    });

    it('returns ok when binary exists and orchestrator mapped', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('node') || String(p).endsWith('node.exe'));
      const r = validateWrapperConfig(cfg, 'claude-code', { isPluginEnabled: () => true });
      expect(r.ok).toBe(true);
    });

    it('fails when orchestrator not in map', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('node') || String(p).endsWith('node.exe'));
      const r = validateWrapperConfig(cfg, 'unknown-cli', { isPluginEnabled: () => true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/unknown-cli/);
    });

    it('fails when binary not on PATH', () => {
      // fs.existsSync default is false; execSync default throws — so binary lookup throws
      const r = validateWrapperConfig({ ...cfg, binary: 'definitely-not-a-binary-xyz' }, 'claude-code', { isPluginEnabled: () => true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not available/i);
    });

    it('fails when contributingPluginId set but plugin disabled', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('node') || String(p).endsWith('node.exe'));
      const r = validateWrapperConfig({ ...cfg, contributingPluginId: 'foo' }, 'claude-code', { isPluginEnabled: () => false });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/foo/);
    });
  });
});
