import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { readCopilotHooksConfig } from '../orchestrators/copilot-hooks-config';
import { ClaudeCodeProvider } from '../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../orchestrators/codex-cli-provider';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
  unlink: vi.fn(() => Promise.resolve(undefined)),
  mkdir: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
import { appLog } from './log-service';
import {
  snapshotFile,
  restoreForAgent,
  restoreAll,
  hasSnapshot,
  getHooksConfigPath,
  isClubhouseHookEntry,
  stripClubhouseHooks,
  stripClubhouseHooksFromFile,
  _resetForTesting,
} from './config-pipeline';

const CLUBHOUSE_HOOK_CMD = 'cat | curl -s -X POST http://127.0.0.1:9999/hook/${CLUBHOUSE_AGENT_ID} -H \'Content-Type: application/json\' -H "X-Clubhouse-Nonce: ${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true';
const COPILOT_OWNED_ENTRY = { type: 'command', bash: CLUBHOUSE_HOOK_CMD.replace('${CLUBHOUSE_AGENT_ID}', '${CLUBHOUSE_AGENT_ID}/preToolUse'), timeoutSec: 5 };

describe('config-pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  describe('stripClubhouseHooksFromFile', () => {
    it('returns false (no-op) when the file does not exist', async () => {
      vi.mocked(pathExists).mockResolvedValueOnce(false);
      const result = await stripClubhouseHooksFromFile('/p/dur/.github/hooks/hooks.json');
      expect(result).toBe(false);
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('returns false for an unreadable / non-JSON file without touching it', async () => {
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce('not json {');
      const result = await stripClubhouseHooksFromFile('/p/dur/hooks.json');
      expect(result).toBe(false);
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('returns false when the file has no Clubhouse hooks', async () => {
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      }));
      const result = await stripClubhouseHooksFromFile('/p/dur/hooks.json');
      expect(result).toBe(false);
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('deletes the file when stripping leaves no settings (Claude-style)', async () => {
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] }] },
      }));
      const result = await stripClubhouseHooksFromFile('/p/dur/.claude/settings.local.json');
      expect(result).toBe(true);
      expect(fsp.unlink).toHaveBeenCalledWith(path.resolve('/p/dur/.claude/settings.local.json'));
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('writes back preserving sibling settings (Copilot-style version field)', async () => {
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        version: 1,
        hooks: { preToolUse: [COPILOT_OWNED_ENTRY] },
      }));
      const result = await stripClubhouseHooksFromFile('/p/dur/.github/hooks/hooks.json');
      expect(result).toBe(true);
      expect(fsp.unlink).not.toHaveBeenCalled();
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written).toEqual({ version: 1, hooks: {} });
    });

    it('does not rewrite ambiguous Copilot permissions on hook disable', async () => {
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        version: 1, permissions: { deny: ['WebFetch'] },
        hooks: { preToolUse: [COPILOT_OWNED_ENTRY] },
      }));
      expect(await stripClubhouseHooksFromFile('/p/dur/.github/hooks/hooks.json')).toBe(false);
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('preserves user-authored hooks alongside the stripped Clubhouse entry', async () => {
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] },
            { hooks: [{ type: 'command', command: 'echo user-hook' }] },
          ],
        },
      }));
      const result = await stripClubhouseHooksFromFile('/p/dur/settings.json');
      expect(result).toBe(true);
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.hooks.PreToolUse).toEqual([
        { hooks: [{ type: 'command', command: 'echo user-hook' }] },
      ]);
    });

    it('removes only the managed callback inside a mixed group, retaining user order and metadata', async () => {
      const before = { type: 'command', command: 'user-before' };
      const after = { type: 'command', command: 'user-after', customKey: true };
      const own = { type: 'command', command: CLUBHOUSE_HOOK_CMD };
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        customSetting: 'keep',
        hooks: {
          PreToolUse: [{ matcher: 'Bash', customGroupKey: 'keep', hooks: [before, own, after] }],
          Stop: [{ hooks: [own] }],
        },
      }));
      expect(await stripClubhouseHooksFromFile('/project/.claude/settings.local.json')).toBe(true);
      const written = JSON.parse(String(vi.mocked(fsp.writeFile).mock.calls[0][1]));
      expect(written).toEqual({
        customSetting: 'keep',
        hooks: { PreToolUse: [{ matcher: 'Bash', customGroupKey: 'keep', hooks: [before, after] }] },
      });
      expect(fsp.unlink).not.toHaveBeenCalled();
    });
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

  describe('restore failure telemetry', () => {
    async function failRestore(filePath: string) {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('original');
      await snapshotFile('agent-1', filePath);
      // Reading the current file fails, then writing the original back fails too.
      const denied = new Error(`EACCES: permission denied, open '${filePath}'`);
      vi.mocked(fsp.readFile).mockRejectedValueOnce(denied);
      vi.mocked(fsp.writeFile).mockRejectedValueOnce(denied);
      await restoreForAgent('agent-1');
      const call = vi.mocked(appLog).mock.calls.find((c) => c[2] === 'Failed to restore');
      return (call?.[3] as { telemetry?: { event: string; attrs?: Array<{ key: string; value: unknown }> } } | undefined)?.telemetry;
    }

    it.each([
      ['/secret-project/.codex/config.toml', 'toml'],
      ['/secret-project/.claude/settings.local.json', 'json'],
    ])('%s sends only the file format (%s)', async (filePath, format) => {
      const telemetry = await failRestore(filePath);
      expect(telemetry).toEqual({
        event: 'clubhouse.config.restore_failed',
        attrs: [{ key: 'clubhouse.config.format', kind: 'enum', value: format }],
      });
      expect(JSON.stringify(telemetry)).not.toMatch(/secret-project|EACCES/);
    });
  });

  describe('stored MCP nonce migration on restore (#2222)', () => {
    const STALE = 'stale-nonce-0000';
    const bridgeWithNonce = { command: 'node', args: ['/app/clubhouse-mcp-bridge.js'], env: { CLUBHOUSE_AGENT_ID: 'a1', CLUBHOUSE_HOOK_NONCE: STALE } };

    it('restoreAll scrubs a stored nonce from the current .mcp.json', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ mcpServers: { clubhouse: bridgeWithNonce } }));
      await snapshotFile('agent-1', '/wt/.mcp.json');
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ mcpServers: { clubhouse: bridgeWithNonce, user: { command: 'u' } } }));

      await restoreAll();

      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).not.toContain(STALE);
      expect(JSON.parse(written).mcpServers.user).toEqual({ command: 'u' });
    });

    it('scrubs the nonce from a pre-#2222 snapshot it writes back when the current file is corrupt', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ mcpServers: { clubhouse: bridgeWithNonce } }));
      await snapshotFile('agent-1', '/wt/.mcp.json');
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{ not json');

      await restoreForAgent('agent-1');

      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).not.toContain(STALE);
      expect(JSON.parse(written).mcpServers).toEqual({});
    });

    it('scrubs the nonce from a TOML snapshot it writes back when the current file is unreadable', async () => {
      const original = `[mcp_servers.clubhouse.env]\nCLUBHOUSE_HOOK_NONCE = "${STALE}"\nKEEP = "1"\n`;
      vi.mocked(fsp.readFile).mockResolvedValueOnce(original);
      await snapshotFile('agent-1', '/wt/.codex/config.toml');
      vi.mocked(fsp.readFile).mockRejectedValueOnce(new Error('EACCES'));

      await restoreForAgent('agent-1');

      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).not.toContain(STALE);
      expect(written).toContain('KEEP = "1"');
    });
  });

  describe('restoreForAgent', () => {
    it.each([false, true])('removes JSON bridges and scrubs user-server nonces (original=%s)', async (existing) => {
      const file = path.join('project', '.mcp.json');
      if (existing) vi.mocked(fsp.readFile).mockResolvedValueOnce('{"mcpServers":{}}');
      else vi.mocked(fsp.readFile).mockRejectedValueOnce(new Error('ENOENT'));
      await snapshotFile('agent-1', file);
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        mcpServers: {
          clubhouse: { command: 'node', args: [path.join('app', 'clubhouse-mcp-bridge.js')] },
          user: { command: 'user', env: { CLUBHOUSE_HOOK_NONCE: 'stale', KEEP: 'yes' } },
        },
        keep: true,
      }));
      await restoreForAgent('agent-1');
      expect(JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string)).toEqual({
        mcpServers: { user: { command: 'user', env: { KEEP: 'yes' } } }, keep: true,
      });
    });

    it('deletes a newly created JSON file containing only the bridge', async () => {
      const file = path.join('project', '.mcp.json');
      vi.mocked(fsp.readFile).mockRejectedValueOnce(new Error('ENOENT'));
      await snapshotFile('agent-1', file);
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        mcpServers: { clubhouse: { command: 'node', args: ['clubhouse-mcp-bridge.js'] } },
      }));
      await restoreForAgent('agent-1');
      expect(fsp.unlink).toHaveBeenCalledWith(path.resolve(file));
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('preserves a user-authored reserved server through corrupt-file fallback', async () => {
      const original = {
        mcpServers: {
          clubhouse: { command: 'user-server' },
          staleBridge: { command: 'node', args: ['clubhouse-mcp-bridge.js'] },
          user: { command: 'user', env: { CLUBHOUSE_HOOK_NONCE: 'stale', KEEP: 'yes' } },
        },
        hooks: { PostToolUse: [{ command: 'curl https://audit.invalid/hook/report' }] },
        keep: true,
      };
      const file = path.join('project', '.mcp.json');
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify(original));
      await snapshotFile('agent-1', file);
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{broken');
      await restoreForAgent('agent-1');
      expect(JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string)).toEqual({
        mcpServers: { clubhouse: { command: 'user-server' }, user: { command: 'user', env: { KEEP: 'yes' } } },
        hooks: original.hooks,
        keep: true,
      });
    });

    it.each([false, true])('preserves bridge-like user servers without deleting their file (original=%s)', async (existing) => {
      const file = path.join('project', '.mcp.json');
      const own = { command: 'node', args: ['server.js', '--label', 'clubhouse-mcp-bridge'] };
      if (existing) vi.mocked(fsp.readFile).mockResolvedValueOnce('{"mcpServers":{}}');
      else vi.mocked(fsp.readFile).mockRejectedValueOnce(new Error('ENOENT'));
      await snapshotFile('agent-1', file);
      vi.mocked(pathExists).mockResolvedValueOnce(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ mcpServers: { own } }));
      await restoreForAgent('agent-1');
      expect(fsp.unlink).not.toHaveBeenCalled();
      expect(JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string)).toEqual({ mcpServers: { own } });
    });

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
    it.each([
      ['Claude', () => new ClaudeCodeProvider(), '.claude/settings.local.json'],
      ['Codex', () => new CodexCliProvider(), '.codex/hooks.json'],
    ] as const)('leaves a refused %s hook setup byte-identical on shutdown', async (_name, makeProvider, relative) => {
      const original = JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: { Stop: [{ hooks: [
          { type: 'command', command: CLUBHOUSE_HOOK_CMD },
          { type: 'command', command: 'user-command' },
        ] }] },
      }, null, '\t') + '\n';
      vi.mocked(fsp.readFile).mockResolvedValue(original);
      await snapshotFile('agent-1', path.join('/project', relative));
      await expect(makeProvider().writeHooksConfig('/project', 'http://127.0.0.1:9999/hook')).rejects.toThrow('Ambiguous Clubhouse hook');
      await restoreAll();
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
      expect(hasSnapshot(path.join('/project', relative))).toBe(false);
    });

    it('preserves commented JSON after refused startup and shutdown', async () => {
      const original = '{\n  // user comment\n  "hooks": {}\n}\n';
      vi.mocked(fsp.readFile).mockResolvedValue(original);
      await snapshotFile('agent-1', '/project/.claude/settings.local.json');
      await expect(new ClaudeCodeProvider().writeHooksConfig('/project', 'http://127.0.0.1:9999/hook')).rejects.toThrow('Invalid JSON');
      await restoreAll();
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('does not clean the snapshot when hook directory access refuses startup', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('{"hooks":{"Stop":[{"command":"${CLUBHOUSE_AGENT_ID}"}]}}\n');
      await snapshotFile('agent-1', '/project/.claude/settings.local.json');
      const error = Object.assign(new Error('directory access denied'), { code: 'EACCES' });
      vi.mocked(fsp.mkdir).mockRejectedValueOnce(error);
      await expect(new ClaudeCodeProvider().writeHooksConfig('/project', 'http://127.0.0.1:9999/hook')).rejects.toBe(error);
      await restoreAll();
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('still removes a managed-only group after successful idempotent setup', async () => {
      vi.mocked(fsp.readFile).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const provider = new ClaudeCodeProvider();
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');
      const current = String(vi.mocked(fsp.writeFile).mock.calls[0][1]);
      vi.mocked(fsp.writeFile).mockClear();
      vi.mocked(fsp.readFile).mockResolvedValue(current);
      await snapshotFile('agent-1', '/project/.claude/settings.local.json');
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');
      expect(fsp.writeFile).not.toHaveBeenCalled();
      await restoreAll();
      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.resolve('/project/.claude/settings.local.json'), '{}', 'utf-8',
      );
    });

    it('restores all snapshots at once', async () => {
      vi.mocked(fsp.readFile)
        .mockResolvedValueOnce('content-a')
        .mockResolvedValueOnce('content-b');

      await snapshotFile('agent-1', '/project-a/.claude/settings.local.json');
      await snapshotFile('agent-2', '/project-b/.github/hooks/hooks.json');

      // Mock reads for smart restore
      vi.mocked(fsp.readFile)
        .mockResolvedValueOnce(JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: CLUBHOUSE_HOOK_CMD }] }] } }))
        .mockResolvedValueOnce(JSON.stringify({ version: 1, hooks: { preToolUse: [COPILOT_OWNED_ENTRY] } }));

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

    it('prefers hooksFile over localSettingsFile when they differ', () => {
      // Codex keeps hooks in .codex/hooks.json but settings in .codex/config.toml.
      // Deriving the path from localSettingsFile pointed snapshot/restore/strip
      // at config.toml, so Clubhouse hook entries were never cleaned up.
      const provider = {
        getCapabilities: () => ({ hooks: true } as any),
        conventions: {
          configDir: '.codex',
          localSettingsFile: 'config.toml',
          hooksFile: 'hooks.json',
        },
      } as any;

      const result = getHooksConfigPath(provider, '/project');
      expect(result).toBe(path.join('/project', '.codex', 'hooks.json'));
      expect(result).not.toContain('config.toml');
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

  describe('concurrent restore serialization', () => {
    it('serializes concurrent restoreForAgent calls via mutex', async () => {
      const callOrder: string[] = [];

      // Make readFile return content so snapshot exists
      vi.mocked(fsp.readFile).mockResolvedValue('{"hooks":{}}');
      vi.mocked(pathExists).mockResolvedValue(true as any);

      // Create a delayed writeFile that tracks call order
      vi.mocked(fsp.writeFile).mockImplementation(async () => {
        callOrder.push('write-start');
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push('write-end');
      });

      // Two agents snapshot the same file
      await snapshotFile('agent-a', '/project/.claude/settings.json');
      await snapshotFile('agent-b', '/project/.claude/settings.json');

      // Both agents exit concurrently — mutex should serialize
      const p1 = restoreForAgent('agent-a');
      const p2 = restoreForAgent('agent-b');
      await Promise.all([p1, p2]);

      // With mutex: agent-b's restore runs after agent-a completes.
      // agent-a decrements refCount to 1 (no file write).
      // agent-b decrements refCount to 0 and restores (one write).
      // Without mutex, overlapping writes would interleave.
      expect(callOrder.filter(c => c === 'write-start').length).toBeLessThanOrEqual(1);
    });
  });
});


describe('Copilot cleanup preservation boundary', () => {
  const file = path.resolve('/copilot/.github/hooks/hooks.json');
  const owned = COPILOT_OWNED_ENTRY;
  const custom = { type: 'command', bash: 'curl https://example.invalid/hook/audit' };
  const original = JSON.stringify({ version: 1, hooks: {}, keep: 'original' });
  const ambiguous = [
    '{broken',
    'null',
    '[]',
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [owned], postToolUse: { bash: 'echo custom' } } }, null, 2),
    JSON.stringify({ version: 1, hooks: [owned] }),
    JSON.stringify({ version: 2, hooks: { preToolUse: [owned] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [owned] }, permissions: { deny: ['WebFetch'] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [owned, { type: 'future', payload: 'keep' }] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [owned, { type: 'command', bash: 'echo ${CLUBHOUSE_AGENT_ID}' }] } }),
    ...[
      { ...owned, powershell: 'Write-Output custom' },
      { ...owned, command: 'echo custom' },
      { ...owned, env: { CUSTOM: 'keep' } },
      { ...owned, args: ['custom'] },
      { ...owned, cwd: '/custom' },
      { ...owned, matcher: 'custom' },
      { ...owned, timeout: 5000 },
      { ...owned, extension: { keep: true } },
      { ...owned, timeoutSec: 10 },
      { ...owned, timeoutSec: 120 },
      { type: 'command', bash: owned.bash },
      { ...owned, bash: owned.bash.replace('/preToolUse ', '/permissionRequest ') },
    ].map((entry) => JSON.stringify({ version: 1, hooks: { preToolUse: [owned, entry] }, keep: 'custom additions' }, null, 2)),
  ];
  function disk(bytes: string | undefined) {
    const state = { bytes, denied: false };
    vi.mocked(fsp.readFile).mockImplementation(async () => {
      if (state.denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (state.bytes === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return state.bytes;
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (_file, value) => { state.bytes = String(value); });
    vi.mocked(fsp.unlink).mockImplementation(async () => { state.bytes = undefined; });
    vi.mocked(pathExists).mockImplementation(async () => state.bytes !== undefined);
    return state;
  }
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    vi.mocked(fsp.readFile).mockReset();
    vi.mocked(fsp.writeFile).mockReset();
    vi.mocked(fsp.unlink).mockReset();
    vi.mocked(pathExists).mockReset();
  });

  it.each(ambiguous)('leaves a stopped ambiguous document byte-exact: %s', async (bytes) => {
    const state = disk(bytes);
    expect(await stripClubhouseHooksFromFile(file)).toBe(false);
    expect(state.bytes).toBe(bytes);
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(fsp.unlink).not.toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('core:config-pipeline', 'warn', expect.stringMatching(/repair/i), expect.anything());
  });

  for (const existing of [false, true]) {
    for (const all of [false, true]) {
      it.each(ambiguous)(`preserves ambiguous current bytes (original=${existing}, all=${all}): %s`, async (bytes) => {
        const state = disk(existing ? original : undefined);
        await snapshotFile('copilot-agent', file);
        state.bytes = bytes;
        if (all) await restoreAll();
        else await restoreForAgent('copilot-agent');
        expect(state.bytes).toBe(bytes);
        expect(fsp.writeFile).not.toHaveBeenCalled();
        expect(fsp.unlink).not.toHaveBeenCalled();
      });

      it(`keeps valid empty hooks readable on next start (original=${existing}, all=${all})`, async () => {
        const state = disk(existing ? original : undefined);
        await snapshotFile('copilot-agent', file);
        state.bytes = JSON.stringify({ version: 1, hooks: { preToolUse: [owned] }, keep: 'current' });
        if (all) await restoreAll();
        else await restoreForAgent('copilot-agent');
        expect(JSON.parse(state.bytes!)).toEqual({ version: 1, hooks: {}, keep: 'current' });
        await expect(readCopilotHooksConfig('/copilot')).resolves.toEqual({ version: 1, hooks: {}, keep: 'current' });
        expect(fsp.unlink).not.toHaveBeenCalled();
      });
    }
  }

  it('preserves custom hook URLs while removing only generated callbacks', async () => {
    const state = disk(JSON.stringify({ version: 1, hooks: { preToolUse: [custom, owned] }, keep: true }));
    expect(await stripClubhouseHooksFromFile(file)).toBe(true);
    expect(JSON.parse(state.bytes!)).toEqual({ version: 1, hooks: { preToolUse: [custom] }, keep: true });
  });

  it('leaves a custom URL-only document byte-exact', async () => {
    const bytes = JSON.stringify({ version: 1, hooks: { preToolUse: [custom] } }, null, 2);
    const state = disk(bytes);
    expect(await stripClubhouseHooksFromFile(file)).toBe(false);
    expect(state.bytes).toBe(bytes);
    expect(fsp.writeFile).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not overwrite unreadable current bytes (original=%s)', async (existing) => {
    const state = disk(existing ? original : undefined);
    await snapshotFile('copilot-agent', file);
    state.bytes = 'unreadable-current-evidence';
    state.denied = true;
    await restoreForAgent('copilot-agent');
    expect(state.bytes).toBe('unreadable-current-evidence');
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves failed running cleanup when the observer throws (all=%s)', async (all) => {
    const state = disk(original);
    await snapshotFile('copilot-agent', file);
    state.bytes = '{corrupt-current';
    const options = { onRepairRequired: vi.fn(() => { throw new Error('notice failed'); }) };
    if (all) await restoreAll(options);
    else await restoreForAgent('copilot-agent', options);
    expect(options.onRepairRequired).toHaveBeenCalledTimes(1);
    expect(state.bytes).toBe('{corrupt-current');
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it('reports a write failure as failure without falling back to an old snapshot', async () => {
    const state = disk(JSON.stringify({ version: 1, hooks: { preToolUse: [owned] } }));
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(new Error('disk full'));
    const options = { onRepairRequired: vi.fn(() => { throw new Error('notice failed'); }) };
    expect(await stripClubhouseHooksFromFile(file, options)).toBe(false);
    expect(options.onRepairRequired).toHaveBeenCalledTimes(1);
    expect(options.onRepairRequired).toHaveBeenCalledWith(expect.stringContaining('cleanup write failed'));
    expect(fsp.writeFile).toHaveBeenCalledTimes(1);
    expect(fsp.unlink).not.toHaveBeenCalled();
    expect(state.bytes).toContain('preToolUse');
  });

  it('does not turn a failed cleanup into mutation when its repair observer throws', async () => {
    const bytes = ambiguous[1];
    const state = disk(bytes);
    const options = { onRepairRequired: vi.fn(() => { throw new Error('notice failed'); }) };
    expect(await stripClubhouseHooksFromFile(file, options)).toBe(false);
    expect(options.onRepairRequired).toHaveBeenCalledTimes(1);
    expect(state.bytes).toBe(bytes);
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(fsp.unlink).not.toHaveBeenCalled();
  });
});
