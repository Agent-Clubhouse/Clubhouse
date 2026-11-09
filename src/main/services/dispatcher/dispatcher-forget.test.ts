import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({ base: '' }));

vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.base }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: () => [] } }));
vi.mock('../agent-config', () => ({ getDurableConfig: vi.fn(async () => null) }));
vi.mock('./dispatcher-service', () => ({
  defaultDispatcherOrchestrator: () => 'claude-code',
  getDispatcherAgentId: () => 'coordinator',
  isDispatcherIdentityAgentId: (id: string) => id === 'coordinator' || id === 'chat',
  refreshDispatcherInstructions: vi.fn(async () => undefined),
}));
vi.mock('./dispatcher-channel', () => ({
  CHAT_UPDATE_TAG: '[FROM:Clubhouse]',
  setChatDelivery: () => {},
  onHandOff: () => () => {},
}));

import { forgetEverything, getForgetGeneration, memoryFingerprint } from './dispatcher-forget';
import { refreshDispatcherInstructions } from './dispatcher-service';
import { _resetDispatcherNewsForTesting, _whenNewsSavedForTesting, heldNews } from './dispatcher-news';
import { DEFAULT_INDEX } from './dispatcher-memory';
import { getDispatcherMemoryPath, getDispatcherPath } from './dispatcher-paths';

h.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-forget-test-'));
afterAll(() => fs.rmSync(h.base, { recursive: true, force: true }));

const memory = () => getDispatcherMemoryPath();
const inBase = (...parts: string[]) => path.join(h.base, ...parts);
const newsFile = () => inBase('dispatcher-news.json');

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Every file under the base folder with its content, except memory, the old notes and the news state. */
function everythingElse(): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set([memory(), path.join(getDispatcherPath(), 'notes'), newsFile()]);
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (skip.has(full) || entry.name.startsWith('notes-archive')) continue;
      if (entry.isDirectory()) walk(full);
      // Forward slashes on every platform, so the keys compare with the literals below.
      else out[path.relative(h.base, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(h.base);
  return out;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await _resetDispatcherNewsForTesting();
  fs.rmSync(h.base, { recursive: true, force: true });
  fs.mkdirSync(h.base, { recursive: true });

  // Memory, as #3038 lays it out, and memory from before it.
  write(path.join(memory(), 'index.md'), '# Index\n- agents/webapp-lead.md\n');
  write(path.join(memory(), 'agents', 'webapp-lead.md'), '## Card\nOwns checkout.\n');
  write(path.join(memory(), 'timeline', '2026-11-08.md'), '- 09:00 checkout fixed\n');
  write(path.join(memory(), 'topics', 'release.md'), 'Status: confirmed\n');
  write(inBase('dispatcher', 'notes-archive', 'old.md'), 'old notes\n');
  write(inBase('dispatcher', 'notes-archive-2', 'older.md'), 'older notes\n');
  write(inBase('dispatcher', 'notes', 'unsorted.md'), 'never sorted\n');
  write(newsFile(), JSON.stringify({ openRequests: [5], held: [{ text: 'Lint is green.', at: 1 }, { text: 'Docs merged.', at: 2 }], shown: [{ text: 'Shown.', at: 3 }] }));

  // What must stay: both agents and their instructions, connections and links, Actions, cards' state.
  write(inBase('dispatcher', '.clubhouse', 'agents.json'), '[{"id":"coordinator","name":"Rosie"}]');
  write(inBase('dispatcher', 'CLAUDE.md'), 'instructions\n');
  write(inBase('dispatcher-chat', '.clubhouse', 'agents.json'), '[{"id":"chat","name":"Rosie"}]');
  write(inBase('dispatcher-connections.json'), '{"links":[{"from":"a","to":"b"}]}');
  write(inBase('dispatcher-connections.pending-removals.json'), '[]');
  write(inBase('actions.json'), '{"actions":[{"id":"act_1","name":"Every weekday at 9"}]}');
  write(inBase('dispatcher-agent-cards.json'), '{"agents":{}}');
});

describe('Forget everything (#3046)', () => {
  it('clears memory, old notes and held news, and leaves agents, connections and Actions', async () => {
    const kept = everythingElse();
    expect(Object.keys(kept)).toEqual(expect.arrayContaining([
      'dispatcher/.clubhouse/agents.json', 'dispatcher-chat/.clubhouse/agents.json', 'dispatcher-connections.json', 'actions.json',
    ]));

    const result = await forgetEverything();

    expect(result).toEqual({ removed: 4, heldNews: 2 });
    // Memory starts over with a fresh index and empty folders.
    expect(fs.readFileSync(path.join(memory(), 'index.md'), 'utf8')).toBe(DEFAULT_INDEX);
    for (const sub of ['agents', 'timeline', 'topics']) expect(fs.readdirSync(path.join(memory(), sub))).toEqual([]);
    expect(fs.existsSync(inBase('dispatcher', 'notes'))).toBe(false);
    expect(fs.existsSync(inBase('dispatcher', 'notes-archive'))).toBe(false);
    expect(fs.existsSync(inBase('dispatcher', 'notes-archive-2'))).toBe(false);

    // Held news goes; open requests and what was shown stay.
    expect(heldNews()).toEqual([]);
    await _whenNewsSavedForTesting();
    expect(JSON.parse(fs.readFileSync(newsFile(), 'utf8'))).toMatchObject({ openRequests: [5], held: [], shown: [{ text: 'Shown.' }] });

    // Nothing else changed.
    expect(everythingElse()).toEqual(kept);
    // The instructions carry the empty index from now on.
    expect(refreshDispatcherInstructions).toHaveBeenCalledTimes(1);
  });

  it('works with nothing to forget', async () => {
    fs.rmSync(memory(), { recursive: true, force: true });
    for (const dir of ['notes', 'notes-archive', 'notes-archive-2']) fs.rmSync(inBase('dispatcher', dir), { recursive: true, force: true });
    fs.rmSync(newsFile());
    expect(await forgetEverything()).toEqual({ removed: 0, heldNews: 0 });
    expect(fs.readFileSync(path.join(memory(), 'index.md'), 'utf8')).toBe(DEFAULT_INDEX);
  });

  it('still clears memory when the instructions can\'t be written again', async () => {
    vi.mocked(refreshDispatcherInstructions).mockRejectedValueOnce(new Error('disk full'));
    const result = await forgetEverything();
    expect(result.removed).toBe(4);
    expect(fs.existsSync(path.join(memory(), 'topics', 'release.md'))).toBe(false);
  });
});

describe('what a phone\'s confirmation is bound to (#3206)', () => {
  it('counts every Forget everything', async () => {
    const before = getForgetGeneration();
    await forgetEverything();
    expect(getForgetGeneration()).toBe(before + 1);
  });
  it('fingerprints the memory folder by its files, total size and newest change, and reads a missing one as empty', async () => {
    const root = inBase('fingerprint', 'memory');
    expect(await memoryFingerprint(root)).toEqual({ files: 0, bytes: 0, newestMs: 0 });
    write(path.join(root, 'index.md'), 'abc');
    write(path.join(root, 'agents', 'a.md'), 'hello');
    const first = await memoryFingerprint(root);
    expect(first).toMatchObject({ files: 2, bytes: 8 });
    expect(first.newestMs).toBeGreaterThan(0);
    write(path.join(root, 'agents', 'a.md'), 'hello there');
    expect(await memoryFingerprint(root)).toMatchObject({ files: 2, bytes: 14 });
    fs.utimesSync(path.join(root, 'index.md'), new Date(first.newestMs + 60_000), new Date(first.newestMs + 60_000));
    expect((await memoryFingerprint(root)).newestMs).toBeGreaterThan(first.newestMs);
  });
});
