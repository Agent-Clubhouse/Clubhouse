/**
 * #3039: one search over the Dispatcher's memory and transcripts. Fixture
 * folders and fixture transcripts in each CLI's format only; no CLI runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '' })),
  invalidateShellEnvironmentCache: vi.fn(),
  buildCliSpawnEnv: vi.fn((env?: Record<string, string>) => ({ ...env })),
}));

import { getShellEnvironment } from '../../util/shell';
import { ClaudeCodeProvider } from '../../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../../orchestrators/codex-cli-provider';
import { CopilotCliProvider } from '../../orchestrators/copilot-cli-provider';
import { registerProvider } from '../../orchestrators/registry';
import {
  paragraphs,
  parseQuery,
  providerTranscriptStores,
  searchDispatcher,
  snippet,
  transcriptRecordText,
  type TranscriptStore,
} from './dispatcher-search';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-search-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function jsonl(records: unknown[]): string {
  return records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
}

// ── Fixture transcripts, one per CLI format ────────────────────────────────

/** Claude Code: `projects/<cwd>/<id>.jsonl`. */
const CLAUDE_RECORDS = [
  { type: 'summary', summary: 'Safari checkout work' },
  { type: 'user', timestamp: '2026-11-07T09:00:00.000Z', message: { role: 'user', content: 'Is Safari checkout fixed yet?' } },
  { type: 'user', isMeta: true, timestamp: '2026-11-07T09:00:01.000Z', message: { role: 'user', content: 'Caveat: Safari checkout (meta)' } },
  {
    type: 'assistant', timestamp: '2026-11-07T09:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'safari checkout' }, { type: 'text', text: 'Asking webapp-lead about Safari checkout.' }, { type: 'tool_use', id: 't1', name: 'send_message', input: { agent: 'webapp-lead', text: 'status?' } }] },
  },
  { type: 'user', timestamp: '2026-11-07T09:01:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'webapp-lead: Safari checkout fixed in #412' }] }] } },
];

/** Codex: `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`. */
function codexRecords(cwd: string): unknown[] {
  return [
    { timestamp: '2026-11-06T10:00:00.000Z', type: 'session_meta', payload: { id: CODEX_ID, cwd, timestamp: '2026-11-06T10:00:00.000Z', base_instructions: { text: 'release checklist' } } },
    { timestamp: '2026-11-06T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'release checklist rules' }] } },
    { timestamp: '2026-11-06T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>release checklist</environment_context>' }, { type: 'input_text', text: 'Tag the release once the checklist passes' }] } },
    { timestamp: '2026-11-06T10:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Tag the release once the checklist passes' } },
    { timestamp: '2026-11-06T10:00:05.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["git","tag","release-1.0"]}', call_id: 'c1' } },
    { timestamp: '2026-11-06T10:00:06.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'tagged release-1.0' } },
    { timestamp: '2026-11-06T10:00:07.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'release' } },
    { timestamp: '2026-11-06T10:00:08.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The release checklist passed and 1.0 is tagged.' }] } },
  ];
}

/** Copilot: `session-state/<id>/events.jsonl`. */
const COPILOT_RECORDS = [
  { type: 'session.start', id: 'e1', parentId: null, timestamp: '2026-11-05T08:00:00.000Z', data: { sessionId: 'x', producer: 'copilot' } },
  { type: 'system.message', id: 'e2', parentId: 'e1', timestamp: '2026-11-05T08:00:00.000Z', data: { role: 'system', content: 'nightly build instructions' } },
  { type: 'user.message', id: 'e3', parentId: 'e2', timestamp: '2026-11-05T08:00:01.000Z', data: { content: 'Why did the nightly build fail?' } },
  { type: 'assistant.message', id: 'e4', parentId: 'e3', timestamp: '2026-11-05T08:00:03.000Z', data: { messageId: 'm1', content: '', toolRequests: [{ toolCallId: 'k1', name: 'bash', arguments: { command: 'cat nightly-build.log' } }] } },
  { type: 'tool.execution_complete', id: 'e5', parentId: 'e4', timestamp: '2026-11-05T08:00:04.000Z', data: { toolCallId: 'k1', success: true, result: { content: 'nightly build: linker error in libpay' } } },
  { type: 'assistant.message', id: 'e6', parentId: 'e5', timestamp: '2026-11-05T08:00:06.000Z', data: { messageId: 'm2', content: 'The nightly build failed on a linker error in libpay.' } },
];

const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '22222222-2222-4222-8222-222222222222';
const COPILOT_ID = '33333333-3333-4333-8333-333333333333';

// ── Query and text helpers ─────────────────────────────────────────────────

describe('parseQuery', () => {
  it('splits words, keeps quoted phrases whole, lowercases and drops repeats', () => {
    expect(parseQuery('Safari  "Checkout Fix" safari')).toEqual(['safari', 'checkout fix']);
    expect(parseQuery('   ')).toEqual([]);
  });
});

describe('snippet', () => {
  it('keeps short text whole on one line', () => {
    expect(snippet('one\n  two', ['two'])).toBe('one two');
  });

  it('cuts long text around the first match', () => {
    const text = `${'a '.repeat(400)}needle ${'b '.repeat(400)}`;
    const s = snippet(text, ['needle']);
    expect(s).toContain('needle');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(282);
  });
});

describe('paragraphs', () => {
  it('starts a new paragraph at blank lines, headings and list items, with 1-based lines', () => {
    expect(paragraphs('# Title\nintro\nmore\n\n- 09:00 one\n- 09:05 two\n  continued')).toEqual([
      { line: 1, text: '# Title\nintro\nmore' },
      { line: 5, text: '- 09:00 one' },
      { line: 6, text: '- 09:05 two\n  continued' },
    ]);
  });
});

// ── Transcript records ─────────────────────────────────────────────────────

describe('transcriptRecordText', () => {
  it('Claude Code: user text, assistant text with tool calls, tool results; skips meta, summaries and thinking', () => {
    const [summary, user, meta, assistant, result] = CLAUDE_RECORDS.map(transcriptRecordText);
    expect(summary).toBeNull();
    expect(meta).toBeNull();
    expect(user).toEqual({ role: 'user', text: 'Is Safari checkout fixed yet?', at: '2026-11-07T09:00:00.000Z' });
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.text).toContain('Asking webapp-lead about Safari checkout.');
    expect(assistant?.text).toContain('send_message {"agent":"webapp-lead","text":"status?"}');
    expect(assistant?.text).not.toContain('thinking');
    expect(result).toEqual({ role: 'tool', text: 'webapp-lead: Safari checkout fixed in #412', at: '2026-11-07T09:01:00.000Z' });
  });

  it('Codex: messages, tool calls and outputs; skips metadata, developer text, added context, event copies and reasoning', () => {
    const texts = codexRecords('/w').map(transcriptRecordText);
    expect(texts[0]).toBeNull();
    expect(texts[1]).toBeNull();
    expect(texts[2]).toEqual({ role: 'user', text: 'Tag the release once the checklist passes', at: '2026-11-06T10:00:02.000Z' });
    expect(texts[3]).toBeNull();
    expect(texts[4]).toMatchObject({ role: 'tool', text: 'shell {"command":["git","tag","release-1.0"]}' });
    expect(texts[5]).toMatchObject({ role: 'tool', text: 'tagged release-1.0' });
    expect(texts[6]).toBeNull();
    expect(texts[7]).toMatchObject({ role: 'assistant', text: 'The release checklist passed and 1.0 is tagged.' });
  });

  it('Codex: reads a payload written as the record itself, as old rollouts did', () => {
    expect(transcriptRecordText({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old style' }] }))
      .toEqual({ role: 'assistant', text: 'old style' });
  });

  it('Copilot: user and assistant messages, tool requests and results; skips session and system events', () => {
    const texts = COPILOT_RECORDS.map(transcriptRecordText);
    expect(texts[0]).toBeNull();
    expect(texts[1]).toBeNull();
    expect(texts[2]).toEqual({ role: 'user', text: 'Why did the nightly build fail?', at: '2026-11-05T08:00:01.000Z' });
    expect(texts[3]).toMatchObject({ role: 'tool', text: 'bash {"command":"cat nightly-build.log"}' });
    expect(texts[4]).toMatchObject({ role: 'tool', text: 'nightly build: linker error in libpay' });
    expect(texts[5]).toMatchObject({ role: 'assistant', text: 'The nightly build failed on a linker error in libpay.' });
  });

  it('is null for anything that is not a record', () => {
    expect(transcriptRecordText(null)).toBeNull();
    expect(transcriptRecordText('text')).toBeNull();
    expect(transcriptRecordText([1, 2])).toBeNull();
  });
});

// ── Memory ─────────────────────────────────────────────────────────────────

function writeMemory(): string {
  const memory = path.join(root, 'memory');
  write(path.join(memory, 'index.md'), '# Index\n\n- Release 1.0 waits on Safari checkout. See topics/checkout.md.\n');
  write(path.join(memory, 'topics', 'checkout.md'), 'Status: confirmed\nSource: webapp-lead\n\nSafari checkout broke after the payment update.\nwebapp-lead owns the fix.\n\n- Safari checkout fixed in #412; all 41 tests pass.\n');
  write(path.join(memory, 'timeline', '2026-11-07.md'), '# 2026-11-07\n\n- 09:01 webapp-lead fixed Safari checkout ([transcript](/t/claude.jsonl#L5))\n- 09:30 release-lead asleep\n');
  write(path.join(memory, 'agents', 'webapp-lead.md'), '# webapp-lead\n\n## Card\n\nOwns the web app and checkout.\n\n## Notes\n\nQuick on Safari bugs.\n');
  write(path.join(memory, 'topics', 'notes.txt'), 'Safari checkout, not a page');
  return memory;
}

const noStores: TranscriptStore[] = [];

describe('searchDispatcher over memory', () => {
  it('finds every paragraph with all the words, with the page, line and a link back', async () => {
    const memory = writeMemory();
    const result = await searchDispatcher('safari checkout', { memoryRoot: memory, stores: noStores, folders: [] });
    expect(result.transcripts).toEqual([]);
    expect(result.memory.map((h) => h.link).sort()).toEqual([
      'memory/index.md#L3',
      'memory/timeline/2026-11-07.md#L3',
      'memory/topics/checkout.md#L4',
      'memory/topics/checkout.md#L7',
    ]);
    const hit = result.memory.find((h) => h.page === 'topics/checkout.md' && h.line === 4)!;
    expect(hit.text).toBe('Safari checkout broke after the payment update. webapp-lead owns the fix.');
    // .txt files and paragraphs with only one of the words aren't hits.
    expect(result.memory.some((h) => h.page.endsWith('.txt'))).toBe(false);
    expect(result.memory.some((h) => h.page === 'agents/webapp-lead.md')).toBe(false);
  });

  it('matches a quoted phrase only as written', async () => {
    const memory = writeMemory();
    const result = await searchDispatcher('"fixed safari checkout"', { memoryRoot: memory, stores: noStores, folders: [] });
    expect(result.memory.map((h) => h.link)).toEqual(['memory/timeline/2026-11-07.md#L3']);
  });

  it('caps hits at the limit and says there are more', async () => {
    const memory = writeMemory();
    const result = await searchDispatcher('safari', { memoryRoot: memory, stores: noStores, folders: [], limit: 2 });
    expect(result.memory).toHaveLength(2);
    expect(result.more).toBe(true);
  });

  it('does not follow links out of memory', async () => {
    const memory = writeMemory();
    const outside = write(path.join(root, 'outside', 'secret.md'), 'Safari checkout secret');
    try {
      fs.symlinkSync(path.dirname(outside), path.join(memory, 'linked'), 'dir');
    } catch {
      return; // no symlinks on this machine (Windows without the right)
    }
    const result = await searchDispatcher('secret', { memoryRoot: memory, stores: noStores, folders: [] });
    expect(result.memory).toEqual([]);
  });

  it('returns nothing for an empty query or no memory, and reads no transcripts with scope memory', async () => {
    const listSessions = vi.fn(async () => []);
    const store: TranscriptStore = { provider: 'x', listSessions, transcriptPath: vi.fn(async () => null) };
    expect(await searchDispatcher('  ', { memoryRoot: root, stores: [store], folders: ['/f'] })).toEqual({ query: '  ', memory: [], transcripts: [] });
    const result = await searchDispatcher('safari', { memoryRoot: path.join(root, 'none'), stores: [store], folders: ['/f'], scope: 'memory' });
    expect(result).toEqual({ query: 'safari', memory: [], transcripts: [] });
    expect(listSessions).not.toHaveBeenCalled();
  });
});

// ── Transcripts, through fake stores ───────────────────────────────────────

function fixtureStore(provider: string, sessions: Array<{ id: string; file: string; lastActiveAt: string }>): TranscriptStore {
  return {
    provider,
    listSessions: async () => sessions.map((s) => ({ sessionId: s.id, lastActiveAt: s.lastActiveAt })),
    transcriptPath: async (id) => sessions.find((s) => s.id === id)?.file ?? null,
  };
}

describe('searchDispatcher over transcripts', () => {
  function stores() {
    const claude = write(path.join(root, 't', 'claude.jsonl'), jsonl(CLAUDE_RECORDS));
    // A blank line and a half-written last line: line numbers still count them.
    const codex = write(path.join(root, 't', 'codex.jsonl'), jsonl([...codexRecords('/w').slice(0, 4), '', ...codexRecords('/w').slice(4), '{"type":"response_item","pay']));
    const copilot = write(path.join(root, 't', 'copilot.jsonl'), jsonl(COPILOT_RECORDS));
    return {
      files: { claude, codex, copilot },
      stores: [
        fixtureStore('claude-code', [{ id: CLAUDE_ID, file: claude, lastActiveAt: '2026-11-07T09:01:00Z' }]),
        fixtureStore('codex-cli', [{ id: CODEX_ID, file: codex, lastActiveAt: '2026-11-06T10:00:08Z' }]),
        fixtureStore('copilot-cli', [{ id: COPILOT_ID, file: copilot, lastActiveAt: '2026-11-05T08:00:06Z' }]),
      ],
    };
  }

  it('finds hits in a Claude Code transcript with the file and line of the record', async () => {
    const { files, stores: s } = stores();
    const result = await searchDispatcher('safari checkout', { memoryRoot: path.join(root, 'none'), stores: s, folders: ['/f'] });
    expect(result.transcripts.map((h) => [h.line, h.role])).toEqual([[5, 'tool'], [4, 'assistant'], [2, 'user']]);
    expect(result.transcripts[0]).toEqual({
      provider: 'claude-code',
      sessionId: CLAUDE_ID,
      file: files.claude,
      line: 5,
      role: 'tool',
      at: '2026-11-07T09:01:00.000Z',
      text: 'webapp-lead: Safari checkout fixed in #412',
      link: `${files.claude}#L5`,
    });
  });

  it('finds hits in a Codex rollout, counting blank lines and skipping a half-written one', async () => {
    const { files, stores: s } = stores();
    const result = await searchDispatcher('release', { memoryRoot: path.join(root, 'none'), stores: s, folders: ['/f'] });
    expect(result.transcripts.every((h) => h.provider === 'codex-cli' && h.file === files.codex)).toBe(true);
    // Records 1-4 are lines 1-4, then a blank line 5, so records 5-8 are lines 6-9.
    expect(result.transcripts.map((h) => [h.line, h.role])).toEqual([[9, 'assistant'], [7, 'tool'], [6, 'tool'], [3, 'user']]);
    expect(result.transcripts[0].link).toBe(`${files.codex}#L9`);
  });

  it('finds hits in a Copilot transcript', async () => {
    const { files, stores: s } = stores();
    const result = await searchDispatcher('nightly build', { memoryRoot: path.join(root, 'none'), stores: s, folders: ['/f'] });
    expect(result.transcripts.map((h) => [h.provider, h.line, h.role])).toEqual([
      ['copilot-cli', 6, 'assistant'], ['copilot-cli', 5, 'tool'], ['copilot-cli', 4, 'tool'], ['copilot-cli', 3, 'user'],
    ]);
    expect(result.transcripts[0]).toMatchObject({ sessionId: COPILOT_ID, link: `${files.copilot}#L6`, at: '2026-11-05T08:00:06.000Z' });
  });

  it('searches memory and every provider at once, newest transcript hits first', async () => {
    const memory = writeMemory();
    const { stores: s } = stores();
    const result = await searchDispatcher('fixed', { memoryRoot: memory, stores: s, folders: ['/f'] });
    expect(result.memory.length).toBeGreaterThan(0);
    expect(result.transcripts.map((h) => h.provider)).toEqual(['claude-code', 'claude-code']);
    const both = await searchDispatcher('a', { memoryRoot: memory, stores: s, folders: ['/f'], limit: 50 });
    const providers = [...new Set(both.transcripts.map((h) => h.provider))];
    expect(providers).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
    const times = both.transcripts.map((h) => Date.parse(h.at!));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('lists sessions in every folder, reads a file once, and skips a store that fails', async () => {
    const { files } = stores();
    const listSessions = vi.fn(async () => [{ sessionId: CLAUDE_ID, lastActiveAt: '2026-11-07T09:01:00Z' }]);
    const shared: TranscriptStore = { provider: 'claude-code', listSessions, transcriptPath: async () => files.claude };
    const broken: TranscriptStore = { provider: 'broken', listSessions: async () => { throw new Error('no store'); }, transcriptPath: async () => null };
    const result = await searchDispatcher('safari checkout', { memoryRoot: path.join(root, 'none'), stores: [broken, shared], folders: ['/coord', '/chat'] });
    expect(listSessions.mock.calls.map((c) => c[0])).toEqual(['/coord', '/chat']);
    expect(result.transcripts).toHaveLength(3);
  });

  it('stops at the byte budget, newest sessions first, and says the search is incomplete', async () => {
    const { stores: s, files } = stores();
    const budget = fs.statSync(files.claude).size + 10;
    const result = await searchDispatcher('a', { memoryRoot: path.join(root, 'none'), stores: s, folders: ['/f'], maxTranscriptBytes: budget, limit: 50 });
    expect(result.incomplete).toBe(true);
    expect(new Set(result.transcripts.map((h) => h.provider))).toEqual(new Set(['claude-code']));
  });

  it('reads no memory with scope transcripts', async () => {
    const memory = writeMemory();
    const { stores: s } = stores();
    const result = await searchDispatcher('safari', { memoryRoot: memory, stores: s, folders: ['/f'], scope: 'transcripts' });
    expect(result.memory).toEqual([]);
    expect(result.transcripts.length).toBeGreaterThan(0);
  });
});

// ── Transcripts, through the real providers on fixture stores ──────────────

describe('providerTranscriptStores', () => {
  it('finds each provider\'s sessions for a folder in its own store, with links to the real files', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-folder-'));
    try {
      const claudeHome = path.join(root, 'claude');
      const codexHome = path.join(root, 'codex');
      const copilotHome = path.join(root, 'copilot');
      vi.mocked(getShellEnvironment).mockReturnValue({ PATH: '', CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, COPILOT_HOME: copilotHome });

      const encoded = path.resolve(folder).replace(/[^a-zA-Z0-9]/g, '-');
      const claudeFile = write(path.join(claudeHome, 'projects', encoded, `${CLAUDE_ID}.jsonl`), jsonl(CLAUDE_RECORDS));
      const codexFile = write(path.join(codexHome, 'sessions', '2026', '11', '06', `rollout-2026-11-06T10-00-00-${CODEX_ID}.jsonl`), jsonl(codexRecords(folder)));
      write(path.join(copilotHome, 'session-state', COPILOT_ID, 'workspace.yaml'), `id: ${COPILOT_ID}\ncwd: ${JSON.stringify(folder)}\n`);
      const copilotFile = write(path.join(copilotHome, 'session-state', COPILOT_ID, 'events.jsonl'), jsonl(COPILOT_RECORDS));
      // Another folder's Codex session isn't searched.
      write(path.join(codexHome, 'sessions', '2026', '11', '06', 'rollout-2026-11-06T11-00-00-44444444-4444-4444-8444-444444444444.jsonl'), jsonl(codexRecords('/elsewhere')));

      registerProvider(new ClaudeCodeProvider());
      registerProvider(new CodexCliProvider());
      registerProvider(new CopilotCliProvider());
      const stores = providerTranscriptStores();
      expect(stores.map((s) => s.provider).sort()).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);

      const options = { memoryRoot: path.join(root, 'none'), stores, folders: [folder], limit: 50 };
      const safari = await searchDispatcher('safari checkout', options);
      expect(safari.transcripts.map((h) => h.link)).toEqual([`${claudeFile}#L5`, `${claudeFile}#L4`, `${claudeFile}#L2`]);
      const release = await searchDispatcher('"tagged release-1.0"', options);
      expect(release.transcripts).toEqual([expect.objectContaining({ provider: 'codex-cli', sessionId: CODEX_ID, link: `${codexFile}#L6` })]);
      const nightly = await searchDispatcher('libpay', options);
      expect(nightly.transcripts.map((h) => h.link)).toEqual([`${copilotFile}#L6`, `${copilotFile}#L5`]);
    } finally {
      vi.mocked(getShellEnvironment).mockReturnValue({ PATH: '' });
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
