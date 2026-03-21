import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
  unlink: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
import {
  snapshotFile,
  restoreForAgent,
  restoreAll,
  hasSnapshot,
  getHooksConfigPath,
  isClubhouseHookEntry,
  stripClubhouseHooks,
  _resetForTesting,
} from './config-pipeline';

const CLUBHOUSE_HOOK_CMD = 'cat | curl -s -X POST http://127.0.0.1:9999/hook/${CLUBHOUSE_AGENT_ID} -H \'Content-Type: application/json\' -H "X-Clubhouse-Nonce: ${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true';

describe('config-pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  describe('snapshotFile', () => {
    it('reads and stores original content on first reference', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{"user": true}');

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');

      expect(fsp.readFile).toHaveBeenCalledWith(
        path.resolve('/project/.claude/settings.local.json'),
        'utf-8',
      );
      expect(hasSnapshot('/project/.claude/settings.local.json')).toBe(true);
    });

    it('stores null when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');

      expect(hasSnapshot('/project/.claude/settings.local.json')).toBe(true);
    });

    it('does not re-read on second call for same path', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('original');

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');
      await snapshotFile('agent-2', '/project/.claude/settings.local.json');

      expect(fsp.readFile).toHaveBeenCalledTimes(1);
    });

    it('increments refCount for subsequent agents', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('original');

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');
      await snapshotFile('agent-2', '/project/.claude/settings.local.json');

      // After restoring agent-1, file should still be tracked (agent-2 still alive)
      await restoreForAgent('agent-1');
      expect(hasSnapshot('/project/.claude/settings.local.json')).toBe(true);

      // After restoring agent-2, file should be restored and no longer tracked
      // Mock readFile for smart restore to read current file
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ hooks: {} }));
      await restoreForAgent('agent-2');
      expect(hasSnapshot('/project/.claude/settings.local.json')).toBe(false);
    });
  });

  describe('restoreForAgent', () => {
    it('strips Clubhouse hooks from current file when restoring (file existed before)', async () => {
      // Original file had user content
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{"user": true}');

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');

      // Current file now has permissions + clubhouse hooks
      const currentContent = JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      });
      vi.mocked(fsp.readFile).mockResolvedValueOnce(currentContent);

      await restoreForAgent('agent-1');

      // Should write back with hooks stripped but permissions preserved
      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.permissions).toEqual({ allow: ['Read'] });
      expect(written.hooks).toBeUndefined();
    });

    it('preserves user hooks while stripping Clubhouse hooks', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{}');

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');

      const currentContent = JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'echo "user hook"' }] },
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      });
      vi.mocked(fsp.readFile).mockResolvedValueOnce(currentContent);

      await restoreForAgent('agent-1');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.hooks.PreToolUse).toHaveLength(1);
      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('echo "user hook"');
    });

    it('deletes file when original was null and only clubhouse hooks remain', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');

      vi.mocked(pathExists).mockResolvedValue(true);
      // Current file has only Clubhouse hooks
      const currentContent = JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      });
      vi.mocked(fsp.readFile).mockResolvedValueOnce(currentContent);

      await restoreForAgent('agent-1');

      expect(fsp.unlink).toHaveBeenCalledWith(
        path.resolve('/project/.claude/settings.local.json'),
      );
    });

    it('preserves file when original was null but permissions were added', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');

      vi.mocked(pathExists).mockResolvedValue(true);
      // Current file has permissions AND Clubhouse hooks
      const currentContent = JSON.stringify({
        permissions: { allow: ['Bash(git:*)'], deny: ['WebFetch'] },
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      });
      vi.mocked(fsp.readFile).mockResolvedValueOnce(currentContent);

      await restoreForAgent('agent-1');

      // Should write back with hooks stripped but permissions preserved
      expect(fsp.unlink).not.toHaveBeenCalled();
      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.permissions).toEqual({ allow: ['Bash(git:*)'], deny: ['WebFetch'] });
      expect(written.hooks).toBeUndefined();
    });

    it('does not delete file when original was null and file already gone', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(pathExists).mockResolvedValue(false);

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');
      await restoreForAgent('agent-1');

      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('does nothing for unknown agentId', async () => {
      await restoreForAgent('nonexistent');
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('decrements refCount without restoring when other agents remain', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('original');

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');
      await snapshotFile('agent-2', '/project/.claude/settings.local.json');
      await restoreForAgent('agent-1');

      // Should NOT have written/deleted yet
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('calling restoreForAgent twice for same agent does not double-restore', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{"user": true}');

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');

      // First restore reads current file
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ hooks: {} }));
      await restoreForAgent('agent-1');

      // Second call with same agentId should be a no-op
      await restoreForAgent('agent-1');

      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
    });

    it('concurrent agent cleanup does not restore the same file twice', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{"user": true}');

      // Two agents reference the same file
      await snapshotFile('agent-1', '/project/.claude/settings.local.json');
      await snapshotFile('agent-2', '/project/.claude/settings.local.json');

      // Restore agent-1 (decrements refCount to 1, no restore yet)
      await restoreForAgent('agent-1');
      expect(fsp.writeFile).not.toHaveBeenCalled();

      // Restore agent-2 (decrements refCount to 0, triggers restore)
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ hooks: {} }));
      await restoreForAgent('agent-2');
      expect(fsp.writeFile).toHaveBeenCalledTimes(1);

      // Snapshot should be gone — a third call should not restore again
      expect(hasSnapshot('/project/.claude/settings.local.json')).toBe(false);
    });

    it('falls back to original snapshot when current file is corrupt', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{"user": true}');

      await snapshotFile('agent-1', '/project/.claude/settings.local.json');

      // Current file is corrupt JSON
      vi.mocked(fsp.readFile).mockResolvedValueOnce('not valid json{{{');

      await restoreForAgent('agent-1');

      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.resolve('/project/.claude/settings.local.json'),
        '{"user": true}',
        'utf-8',
      );
    });

    // ── TOML restore tests ─────────────────────────────────────

    it('strips Clubhouse MCP from TOML config on restore (file existed)', async () => {
      const originalToml = '[mcp_servers.user-server]\ncommand = "python"\n';
      vi.mocked(fsp.readFile).mockResolvedValueOnce(originalToml);

      await snapshotFile('agent-1', '/project/.codex/config.toml');

      // Current file has user server + injected clubhouse
      const currentToml = [
        '[mcp_servers.user-server]',
        'command = "python"',
        '',
        '[mcp_servers.clubhouse]',
        'command = "node"',
        '',
        '[mcp_servers.clubhouse.env]',
        'CLUBHOUSE_MCP_PORT = "12345"',
      ].join('\n');
      vi.mocked(fsp.readFile).mockResolvedValueOnce(currentToml);

      await restoreForAgent('agent-1');

      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toContain('[mcp_servers.user-server]');
      expect(written).not.toContain('[mcp_servers.clubhouse]');
    });

    it('deletes TOML config when file did not exist and only clubhouse remains', async () => {
      vi.mocked(fsp.readFile).mockRejectedValueOnce(new Error('ENOENT'));

      await snapshotFile('agent-1', '/project/.codex/config.toml');

      vi.mocked(pathExists).mockResolvedValue(true);
      const currentToml = '[mcp_servers.clubhouse]\ncommand = "node"\n';
      vi.mocked(fsp.readFile).mockResolvedValueOnce(currentToml);

      await restoreForAgent('agent-1');

      expect(fsp.unlink).toHaveBeenCalledWith(
        path.resolve('/project/.codex/config.toml'),
      );
    });

    it('preserves non-clubhouse content in TOML when file did not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValueOnce(new Error('ENOENT'));

      await snapshotFile('agent-1', '/project/.codex/config.toml');

      vi.mocked(pathExists).mockResolvedValue(true);
      const currentToml = [
        '[mcp_servers.user-server]',
        'command = "python"',
        '',
        '[mcp_servers.clubhouse]',
        'command = "node"',
      ].join('\n');
      vi.mocked(fsp.readFile).mockResolvedValueOnce(currentToml);

      await restoreForAgent('agent-1');

      expect(fsp.unlink).not.toHaveBeenCalled();
      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toContain('[mcp_servers.user-server]');
      expect(written).not.toContain('[mcp_servers.clubhouse]');
    });

    it('falls back to original TOML when current file is unreadable', async () => {
      const originalToml = '[mcp_servers.user-server]\ncommand = "python"\n';
      vi.mocked(fsp.readFile).mockResolvedValueOnce(originalToml);

      await snapshotFile('agent-1', '/project/.codex/config.toml');

      vi.mocked(fsp.readFile).mockRejectedValueOnce(new Error('EACCES'));

      await restoreForAgent('agent-1');

      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.resolve('/project/.codex/config.toml'),
        originalToml,
        'utf-8',
      );
    });
  });

  describe('restoreAll', () => {
    it('restores all snapshots at once', async () => {
      vi.mocked(fsp.readFile)
        .mockResolvedValueOnce('content-a')
        .mockResolvedValueOnce('content-b');

      await snapshotFile('agent-1', '/project-a/.claude/settings.local.json');
      await snapshotFile('agent-2', '/project-b/.github/hooks/hooks.json');

      // Mock reads for smart restore
      vi.mocked(fsp.readFile)
        .mockResolvedValueOnce(JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] }] } }))
        .mockResolvedValueOnce(JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] }] } }));

      await restoreAll();

      expect(fsp.writeFile).toHaveBeenCalledTimes(2);
      expect(hasSnapshot('/project-a/.claude/settings.local.json')).toBe(false);
      expect(hasSnapshot('/project-b/.github/hooks/hooks.json')).toBe(false);
    });

    it('clears all tracking state', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('original');
      await snapshotFile('agent-1', '/project/.claude/settings.local.json');

      // Mock read for smart restore
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({}));
      await restoreAll();

      // Calling restoreForAgent should be a no-op now
      vi.mocked(fsp.writeFile).mockClear();
      await restoreForAgent('agent-1');
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('stripClubhouseHooks', () => {
    it('removes all Clubhouse hook entries', () => {
      const settings = {
        permissions: { allow: ['Read'] },
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
          PostToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      };

      const result = stripClubhouseHooks(settings);
      expect(result.permissions).toEqual({ allow: ['Read'] });
      expect(result.hooks).toBeUndefined();
    });

    it('preserves user hooks alongside Clubhouse hooks', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'echo "user"' }] },
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      };

      const result = stripClubhouseHooks(settings);
      expect((result.hooks as any).PreToolUse).toHaveLength(1);
      expect((result.hooks as any).PreToolUse[0].hooks[0].command).toBe('echo "user"');
    });

    it('returns settings unchanged when no hooks present', () => {
      const settings = { permissions: { allow: ['Read'] } };
      const result = stripClubhouseHooks(settings);
      expect(result).toEqual(settings);
    });

    it('does not mutate the original object', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      };
      const original = JSON.parse(JSON.stringify(settings));
      stripClubhouseHooks(settings);
      expect(settings).toEqual(original);
    });
  });

  describe('getHooksConfigPath', () => {
    it('returns correct path for Claude Code provider', () => {
      const provider = {
        getCapabilities: () => ({ hooks: true } as any),
        conventions: { configDir: '.claude', localSettingsFile: 'settings.local.json' },
      } as any;

      const result = getHooksConfigPath(provider, '/project');
      expect(result).toBe(path.join('/project', '.claude', 'settings.local.json'));
    });

    it('returns correct path for Copilot provider', () => {
      const provider = {
        getCapabilities: () => ({ hooks: true } as any),
        conventions: { configDir: '.github', localSettingsFile: 'hooks/hooks.json' },
      } as any;

      const result = getHooksConfigPath(provider, '/project');
      expect(result).toBe(path.join('/project', '.github', 'hooks/hooks.json'));
    });

    it('returns null when provider does not support hooks', () => {
      const provider = {
        getCapabilities: () => ({ hooks: false } as any),
        conventions: { configDir: '.codex', localSettingsFile: 'config.toml' },
      } as any;

      expect(getHooksConfigPath(provider, '/project')).toBeNull();
    });
  });

  describe('isClubhouseHookEntry', () => {
    it('detects Claude Code format hook entries', () => {
      const entry = {
        hooks: [{ type: 'command', command: 'cat | curl -s -X POST http://127.0.0.1:9999/hook/${CLUBHOUSE_AGENT_ID}' }],
      };
      expect(isClubhouseHookEntry(entry)).toBe(true);
    });

    it('detects Copilot format hook entries (bash field)', () => {
      const entry = {
        type: 'command',
        bash: 'cat | curl -s -X POST http://127.0.0.1:9999/hook/${CLUBHOUSE_AGENT_ID}',
        timeoutSec: 5,
      };
      expect(isClubhouseHookEntry(entry)).toBe(true);
    });

    it('returns false for user-defined hook entries', () => {
      const userEntry = {
        hooks: [{ type: 'command', command: 'echo "user hook"' }],
      };
      expect(isClubhouseHookEntry(userEntry)).toBe(false);
    });

    it('returns false for non-object entries', () => {
      expect(isClubhouseHookEntry(null)).toBe(false);
      expect(isClubhouseHookEntry('string')).toBe(false);
      expect(isClubhouseHookEntry(42)).toBe(false);
    });

    it('detects entries containing /hook/ URL pattern', () => {
      const entry = {
        hooks: [{ type: 'command', command: 'curl http://127.0.0.1:8080/hook/some-agent' }],
      };
      expect(isClubhouseHookEntry(entry)).toBe(true);
    });
  });
});
