import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fs from 'fs';
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
    it('reads and stores original content on first reference', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce('{"user": true}');

      snapshotFile('agent-1', '/project/.claude/settings.local.json');

      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.resolve('/project/.claude/settings.local.json'),
        'utf-8',
      );
      expect(hasSnapshot('/project/.claude/settings.local.json')).toBe(true);
    });

    it('stores null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      snapshotFile('agent-1', '/project/.claude/settings.local.json');

      expect(hasSnapshot('/project/.claude/settings.local.json')).toBe(true);
    });

    it('does not re-read on second call for same path', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce('original');

      snapshotFile('agent-1', '/project/.claude/settings.local.json');
      snapshotFile('agent-2', '/project/.claude/settings.local.json');

      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('increments refCount for subsequent agents', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce('original');

      snapshotFile('agent-1', '/project/.claude/settings.local.json');
      snapshotFile('agent-2', '/project/.claude/settings.local.json');

      // After restoring agent-1, file should still be tracked (agent-2 still alive)
      restoreForAgent('agent-1');
      expect(hasSnapshot('/project/.claude/settings.local.json')).toBe(true);

      // After restoring agent-2, file should be restored and no longer tracked
      // Mock readFileSync for smart restore to read current file
      vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ hooks: {} }));
      restoreForAgent('agent-2');
      expect(hasSnapshot('/project/.claude/settings.local.json')).toBe(false);
    });
  });

  describe('restoreForAgent', () => {
    it('strips Clubhouse hooks from current file when restoring (file existed before)', () => {
      // Original file had user content
      vi.mocked(fs.readFileSync).mockReturnValueOnce('{"user": true}');

      snapshotFile('agent-1', '/project/.claude/settings.local.json');

      // Current file now has permissions + clubhouse hooks
      const currentContent = JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      });
      vi.mocked(fs.readFileSync).mockReturnValueOnce(currentContent);

      restoreForAgent('agent-1');

      // Should write back with hooks stripped but permissions preserved
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.permissions).toEqual({ allow: ['Read'] });
      expect(written.hooks).toBeUndefined();
    });

    it('preserves user hooks while stripping Clubhouse hooks', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce('{}');

      snapshotFile('agent-1', '/project/.claude/settings.local.json');

      const currentContent = JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'echo "user hook"' }] },
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      });
      vi.mocked(fs.readFileSync).mockReturnValueOnce(currentContent);

      restoreForAgent('agent-1');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.hooks.PreToolUse).toHaveLength(1);
      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('echo "user hook"');
    });

    it('deletes file when original was null and only clubhouse hooks remain', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      snapshotFile('agent-1', '/project/.claude/settings.local.json');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Current file has only Clubhouse hooks
      const currentContent = JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      });
      vi.mocked(fs.readFileSync).mockReturnValueOnce(currentContent);

      restoreForAgent('agent-1');

      expect(fs.unlinkSync).toHaveBeenCalledWith(
        path.resolve('/project/.claude/settings.local.json'),
      );
    });

    it('preserves file when original was null but permissions were added', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      snapshotFile('agent-1', '/project/.claude/settings.local.json');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Current file has permissions AND Clubhouse hooks
      const currentContent = JSON.stringify({
        permissions: { allow: ['Bash(git:*)'], deny: ['WebFetch'] },
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
          ],
        },
      });
      vi.mocked(fs.readFileSync).mockReturnValueOnce(currentContent);

      restoreForAgent('agent-1');

      // Should write back with hooks stripped but permissions preserved
      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.permissions).toEqual({ allow: ['Bash(git:*)'], deny: ['WebFetch'] });
      expect(written.hooks).toBeUndefined();
    });

    it('does not delete file when original was null and file already gone', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      snapshotFile('agent-1', '/project/.claude/settings.local.json');
      restoreForAgent('agent-1');

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('does nothing for unknown agentId', () => {
      restoreForAgent('nonexistent');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('decrements refCount without restoring when other agents remain', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce('original');

      snapshotFile('agent-1', '/project/.claude/settings.local.json');
      snapshotFile('agent-2', '/project/.claude/settings.local.json');
      restoreForAgent('agent-1');

      // Should NOT have written/deleted yet
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('falls back to original snapshot when current file is corrupt', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce('{"user": true}');

      snapshotFile('agent-1', '/project/.claude/settings.local.json');

      // Current file is corrupt JSON
      vi.mocked(fs.readFileSync).mockReturnValueOnce('not valid json{{{');

      restoreForAgent('agent-1');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.resolve('/project/.claude/settings.local.json'),
        '{"user": true}',
        'utf-8',
      );
    });
  });

  describe('restoreAll', () => {
    it('restores all snapshots at once', () => {
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce('content-a')
        .mockReturnValueOnce('content-b');

      snapshotFile('agent-1', '/project-a/.claude/settings.local.json');
      snapshotFile('agent-2', '/project-b/.github/hooks/hooks.json');

      // Mock reads for smart restore
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] }] } }))
        .mockReturnValueOnce(JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] }] } }));

      restoreAll();

      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
      expect(hasSnapshot('/project-a/.claude/settings.local.json')).toBe(false);
      expect(hasSnapshot('/project-b/.github/hooks/hooks.json')).toBe(false);
    });

    it('clears all tracking state', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce('original');
      snapshotFile('agent-1', '/project/.claude/settings.local.json');

      // Mock read for smart restore
      vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({}));
      restoreAll();

      // Calling restoreForAgent should be a no-op now
      vi.mocked(fs.writeFileSync).mockClear();
      restoreForAgent('agent-1');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
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
        conventions: { configDir: '.opencode', localSettingsFile: 'opencode.json' },
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
