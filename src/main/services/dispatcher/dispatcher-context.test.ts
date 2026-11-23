import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import work from './dispatcher-instructions.md';
import chat from './dispatcher-chat-instructions.md';
import { ClaudeCodeProvider } from '../../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../../orchestrators/codex-cli-provider';
import { CopilotCliProvider } from '../../orchestrators/copilot-cli-provider';
import { DISPATCHER_NAME_MAX, personalityInstructions } from '../../../shared/dispatcher-personality';
import { appendSection, boundBuiltinInstructions, DISPATCHER_BUILTIN_CAP_BYTES, instructionsWithSkills, skillFile, writeDispatcherSkills } from './dispatcher-skills';
import { MEMORY_LOOKUP_INSTRUCTIONS, withMemoryIndex } from './dispatcher-memory-migration';
import { MAX_MEMORY_ACCESS_PAGES, memoryAccessPath, memoryWrite, readMemoryAccess, recordMemoryRead } from './dispatcher-memory';
import { readDispatcherMemory } from './dispatcher-memory-reader';
import { searchDispatcher, MAX_MEMORY_PAGE_BYTES, type SearchOptions, type TranscriptStore } from './dispatcher-search';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-context-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const providers = [new ClaudeCodeProvider(), new CodexCliProvider(), new CopilotCliProvider()];

describe('bounded durable Dispatcher context', () => {
  it.each(providers)('keeps current facts outside instructions across repeated real writes on $id', async (provider) => {
    const dir = temp();
    const root = path.join(dir, 'memory');
    const opts = { memoryRoot: root, notesDir: path.join(dir, 'notes') };
    const custom = 'Keep my exact phrasing.\r\nDo not replace it. 🧭\n  Preserve these spaces.  ';
    await writeDispatcherSkills(dir, 'work', provider.conventions);
    const procedural = fs.readFileSync(path.join(dir, skillFile(provider.conventions, 'tool-procedures')), 'utf8');
    expect(procedural).toContain('No hooks, filters, setup, submodules, installs or repository code are run by import.');
    expect(procedural).toContain('Only through Clubhouse tools.');
    const inputs = [instructionsWithSkills(work, 'work', provider.conventions), appendSection(instructionsWithSkills(chat, 'chat', provider.conventions), personalityInstructions('Sample', { preset: 'custom', text: custom }))];
    for (const input of inputs) {
      const initial = await withMemoryIndex(input, opts);
      for (let n = 0; n < 8; n++) {
        const facts = `Current decision ${n}: wait for explicit approval.\n${'linked detail '.repeat(n * 80)}`;
        await memoryWrite('index.md', facts, 'agent tool', root);
        const rendered = await withMemoryIndex(input, opts);
        await provider.writeInstructions(dir, rendered);
        expect(await provider.readInstructions(dir)).toBe(initial);
        expect(rendered).not.toContain(`Current decision ${n}`);
        expect(rendered).toContain(MEMORY_LOOKUP_INSTRUCTIONS);
        expect((await readDispatcherMemory(undefined, root)).text).toContain(`Current decision ${n}`);
        expect(fs.readFileSync(path.join(root, 'index.md'), 'utf8')).toBe(facts);
        expect(fs.readdirSync(path.join(root, 'history', 'index.md')).length).toBeLessThanOrEqual(5);
      }
      // Stored custom text is copied whole; it is not part of a truncation budget.
      if (input.includes(custom)) expect(initial).toContain(custom);
      expect(Buffer.byteLength(initial)).toBeLessThan(24 * 1024);
    }
  });

  it('refuses oversized shipped context instead of silently trimming authority or user text', () => {
    const exact = 'x'.repeat(DISPATCHER_BUILTIN_CAP_BYTES);
    expect(boundBuiltinInstructions(exact)).toBe(exact);
    expect(() => boundBuiltinInstructions(`${exact}x`)).toThrow(/context budget/);
    expect(() => instructionsWithSkills(exact, 'work', providers[0].conventions)).toThrow(/context budget/);
    expect(() => boundBuiltinInstructions('🧭'.repeat(DISPATCHER_BUILTIN_CAP_BYTES / 4 + 1))).toThrow(/context budget/);
    for (const provider of providers) {
      for (const [role, base] of [['work', work], ['chat', chat]] as const) {
        expect(Buffer.byteLength(instructionsWithSkills(base, role, provider.conventions))).toBeLessThanOrEqual(DISPATCHER_BUILTIN_CAP_BYTES);
        expect(Buffer.byteLength(instructionsWithSkills(base.replace(/\n/g, '\r\n'), role, provider.conventions))).toBeLessThanOrEqual(DISPATCHER_BUILTIN_CAP_BYTES);
      }
      const maximumCustom = '界'.repeat(2_000);
      const full = appendSection(instructionsWithSkills(chat, 'chat', provider.conventions), personalityInstructions('界'.repeat(DISPATCHER_NAME_MAX), { preset: 'custom', text: maximumCustom }));
      expect(full).toContain(maximumCustom);
      expect(Buffer.byteLength(full + MEMORY_LOOKUP_INSTRUCTIONS)).toBeLessThan(24 * 1024);
    }
  });

  it('finds retained historical evidence on demand without promoting it into current search or changing bytes', async () => {
    const root = path.join(temp(), 'memory');
    await memoryWrite('index.md', '- historic-canary decision: hold launch.\n', 'agent tool', root);
    await memoryWrite('index.md', '- current-canary decision: review complete.\n', 'agent tool', root);
    const opts: SearchOptions = { memoryRoot: root, stores: [], folders: [] };
    expect((await searchDispatcher('historic-canary', opts)).memory).toEqual([]);
    const result = await searchDispatcher('historic-canary', { ...opts, scope: 'history' });
    expect(result.transcripts).toEqual([]);
    expect(result.memory).toHaveLength(1);
    const page = result.memory[0].page;
    expect(page).toMatch(/^history\/index.md\/\d+-[a-f0-9]+.md$/);
    const file = path.join(root, page);
    const before = fs.readFileSync(file);
    expect((await readDispatcherMemory(page, root)).text).toContain('historic-canary');
    expect(fs.readFileSync(file)).toEqual(before);
    expect((await readDispatcherMemory(undefined, root)).text).toContain('current-canary');
    const stores: TranscriptStore[] = [{ provider: 'sentinel', listSessions: () => { throw new Error('history must not inspect transcripts'); }, transcriptPath: async () => null }];
    await expect(searchDispatcher('historic-canary', { memoryRoot: root, stores, folders: ['/unused'], scope: 'history' })).resolves.toMatchObject({ transcripts: [] });
  });

  it('history reads cannot evict active access metadata or refresh active facts', async () => {
    const root = path.join(temp(), 'memory');
    const page = 'history/index.md/1795464097096-aabb.md';
    const target = path.join(root, page);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const historic = 'historic-pool-canary: old evidence, not current authority.\n';
    fs.writeFileSync(target, historic);
    const entries = Object.fromEntries(Array.from({ length: MAX_MEMORY_ACCESS_PAGES }, (_, n) => [
      `topics/active-${n}.md`, { reads: 1, writes: 0, lastRead: n + 1 },
    ]));
    const access = memoryAccessPath(root);
    fs.writeFileSync(access, JSON.stringify({ version: 1, pages: entries }));
    const before = fs.readFileSync(access);
    const beforeMtime = fs.statSync(target).mtimeMs;
    expect((await searchDispatcher('historic-pool-canary', { memoryRoot: root, scope: 'history', stores: [], folders: [] })).memory).toHaveLength(1);
    expect((await readDispatcherMemory(page, root)).text).toBe(historic);
    expect(fs.readFileSync(access).equals(before)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(historic);
    expect(fs.statSync(target).mtimeMs).toBe(beforeMtime);
    expect(Object.keys(await readMemoryAccess(root))).toHaveLength(MAX_MEMORY_ACCESS_PAGES);
    // The guard is specific to history, not a blanket disabling of current-page access tracking.
    await recordMemoryRead('topics/active-0.md', root, 12345);
    expect((await readMemoryAccess(root))['topics/active-0.md']).toMatchObject({ reads: 2, lastRead: 12345 });
  });

  it('reports withheld historical coverage instead of claiming an absent fact', async () => {
    const root = path.join(temp(), 'memory');
    const history = path.join(root, 'history', 'index.md');
    fs.mkdirSync(history, { recursive: true });
    fs.writeFileSync(path.join(history, 'oversized.md'), 'canary'.padEnd(MAX_MEMORY_PAGE_BYTES + 1, 'x'));
    const result = await searchDispatcher('canary', { memoryRoot: root, scope: 'history', stores: [], folders: [] });
    expect(result.memory).toEqual([]);
    expect(result.incomplete).toBe(true);
    const unreadable = path.join(temp(), 'not-a-directory');
    fs.writeFileSync(unreadable, 'x');
    expect((await searchDispatcher('canary', { memoryRoot: unreadable, scope: 'history', stores: [], folders: [] })).incomplete).toBe(true);
  });

  it('does not follow a history symlink outside memory or expose history in the default directory', async () => {
    const dir = temp();
    const root = path.join(dir, 'memory');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.md'), 'outside-canary');
    fs.symlinkSync(outside, path.join(root, 'history'), process.platform === 'win32' ? 'junction' : 'dir');
    const opts: SearchOptions = { memoryRoot: root, stores: [], folders: [] };
    expect((await searchDispatcher('outside-canary', { ...opts, scope: 'history' })).memory).toEqual([]);
    expect((await readDispatcherMemory(undefined, root)).pages).toEqual([]);
  });
});
