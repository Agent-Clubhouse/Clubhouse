import { describe, it, expect, vi, beforeEach } from 'vitest';
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
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: `/usr/local/bin${path.delimiter}/usr/bin` })),
}));

import * as fs from 'fs';
import { execSync } from 'child_process';
import { findBinaryInPath, homePath, humanizeModelId, parseModelChoicesFromHelp, buildSummaryInstruction, readQuickSummary, applyLaunchWrapper } from './shared';
import type { LaunchWrapperConfig } from '../../shared/types';

describe('shared orchestrator utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
  });

  describe('findBinaryInPath', () => {
    it('finds binary via where/which (shell-native lookup)', () => {
      const shellResult = process.platform === 'win32'
        ? 'C:\\Program Files\\cli\\claude.exe\r\n'
        : '/usr/local/bin/claude\n';
      const expected = shellResult.trim().split(/\r?\n/)[0].trim();
      vi.mocked(execSync).mockReturnValue(shellResult);
      vi.mocked(fs.existsSync).mockImplementation((p) => p === expected);
      const result = findBinaryInPath(['claude'], []);
      expect(result).toBe(expected);
    });

    it('handles multi-line shell output (startup messages before path)', () => {
      if (process.platform === 'win32') return; // Unix-only test
      // Simulates shell startup messages (e.g., nvm loading) appearing before `which` output
      const shellOutput = 'Loading nvm...\nnvm loaded\n/home/user/.nvm/versions/node/v20/bin/codex\n';
      vi.mocked(execSync).mockReturnValue(shellOutput);
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
        'opencode': { subcommand: 'opencode' },
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
        wrapperConfig, 'copilot-cli', 'copilot', ['--help'], ['workiq']
      );
      expect(result).toEqual({
        binary: 'mywrapper',
        args: ['copilot', '--mcp', 'workiq', '--', '--help'],
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
        wrapperConfig, 'claude-code', 'claude', [], ['ado', 'kusto', 'workiq', 'icm']
      );
      expect(result.args).toEqual([
        'claude', '--mcp', 'ado', '--mcp', 'kusto', '--mcp', 'workiq', '--mcp', 'icm', '--',
      ]);
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
});
