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
import { findBinaryInPath, homePath, buildSummaryInstruction, readQuickSummary } from './shared';

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

    it('prioritizes where/which result over PATH scan and extraPaths', () => {
      const whereResult = '/found/by/where/claude';
      const pathResult = path.join('/usr/local/bin', 'claude');
      vi.mocked(execSync).mockReturnValue(whereResult + '\n');
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return p === whereResult || p === pathResult || p === '/extra/claude';
      });
      const result = findBinaryInPath(['claude'], ['/extra/claude']);
      expect(result).toBe(whereResult);
    });

    it('falls through all stages in order when earlier stages miss', () => {
      // where/which fails (default mock), PATH has no match, extraPath works
      vi.mocked(fs.existsSync).mockImplementation((p) => p === '/fallback/claude');
      const result = findBinaryInPath(['claude'], ['/fallback/claude']);
      expect(result).toBe('/fallback/claude');
    });
  });

  describe('homePath', () => {
    it('joins segments under home directory', () => {
      const result = homePath('.local', 'bin', 'claude');
      expect(result).toBe(path.join('/tmp/clubhouse-test-home', '.local', 'bin', 'claude'));
    });

    it('works with single segment', () => {
      const result = homePath('.claude');
      expect(result).toBe(path.join('/tmp/clubhouse-test-home', '.claude'));
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
