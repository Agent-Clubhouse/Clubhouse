import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { appLog } from './log-service';
import { removeSavedChatCliDenylist } from './retired-chat-cli-denylist';

describe('removeSavedChatCliDenylist (#3515)', () => {
  let dir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-denylist-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removes the saved list and the copies beside it, and logs once', async () => {
    const stale = ['chat-cli-denylist.json', 'chat-cli-denylist.json.unreadable', 'chat-cli-denylist.json.unreadable.1', 'chat-cli-denylist.json.unreadable.12', '.chat-cli-denylist.json.tmp-4242-7', 'chat-cli-denylist.json.tmp-4242-7'];
    for (const name of [...new Set(stale), 'settings.json', 'chat-cli-denylist-notes.txt']) fs.writeFileSync(path.join(dir, name), '{}');

    expect((await removeSavedChatCliDenylist(dir)).sort()).toEqual([...new Set(stale)].sort());
    expect(fs.readdirSync(dir).sort()).toEqual(['chat-cli-denylist-notes.txt', 'settings.json']);
    expect(appLog).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledWith('core:chat', 'info', expect.stringContaining('saved chat CLI denylist'), expect.anything());
  });

  it('leaves look-alike names alone, since the app did not write them', async () => {
    const lookAlikes = [
      'chat-cli-denylist.json.bak', 'chat-cli-denylist.json.old', 'chat-cli-denylist.json.orig', 'chat-cli-denylist.json~',
      'chat-cli-denylist.json.unreadable.0', 'chat-cli-denylist.json.unreadable.x', 'chat-cli-denylist.json.unreadable.1.bak',
      '.chat-cli-denylist.json.tmp-', '.chat-cli-denylist.json.tmp-12', '.chat-cli-denylist.json.tmp-0-1', '.chat-cli-denylist.json.tmp-1-1.bak',
      'chat-cli-denylist.json.tmp-a-b', 'my-chat-cli-denylist.json', 'Chat-CLI-Denylist.json', 'chat-cli-denylistXjson',
    ];
    for (const name of lookAlikes) fs.writeFileSync(path.join(dir, name), '{}');
    expect(await removeSavedChatCliDenylist(dir)).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual([...lookAlikes].sort());
    expect(appLog).not.toHaveBeenCalled();
  });

  it('skips a folder with a matching name and still removes the rest', async () => {
    fs.mkdirSync(path.join(dir, 'chat-cli-denylist.json.unreadable'));
    fs.writeFileSync(path.join(dir, 'chat-cli-denylist.json'), '{}');
    expect(await removeSavedChatCliDenylist(dir)).toEqual(['chat-cli-denylist.json']);
    expect(fs.existsSync(path.join(dir, 'chat-cli-denylist.json.unreadable'))).toBe(true);
    expect(appLog).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledWith('core:chat', 'info', expect.any(String), expect.anything());
  });

  it('does nothing, and logs nothing, once the file is gone', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
    expect(await removeSavedChatCliDenylist(dir)).toEqual([]);
    expect(appLog).not.toHaveBeenCalled();
  });

  it('logs a warning, never throws, when the folder cannot be read', async () => {
    expect(await removeSavedChatCliDenylist(path.join(dir, 'missing'))).toEqual([]);
    expect(appLog).toHaveBeenCalledWith('core:chat', 'warn', expect.any(String), expect.anything());
  });
});
