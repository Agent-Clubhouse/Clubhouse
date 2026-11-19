import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { syncBuiltinESMExports } from 'module';
import { AgentCards, NO_ANSWER_MS, type AgentCardDeps, type CardRecord } from './dispatcher-agent-cards';
import { agentPagePath, renderAgentPage, AGENT_CARD_PLACEHOLDER } from './dispatcher-memory';
import { DISPLAY_CARD_INDEX_BYTES, DISPLAY_CARD_PREFIX_BYTES } from './dispatcher-agent-card-display';
import * as files from '../read-only-worktree-file';
import { readAgentCardViewForDisplay, setAgentCardSource, type AgentCardSource } from './dispatcher-agent-card-source';
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
let root: string, memory: string, store: string, clock: number, deps: AgentCardDeps, cards: AgentCards;
const project = path.resolve('/selected-project');
const row = (extra: Partial<CardRecord> = {}): CardRecord => ({ projectPath: project, page: 'selected', setup: 'PRIVATE_SETUP', connected: true, ...extra });
const put = (selected: unknown = row(), extra: Record<string, unknown> = {}) => fs.writeFileSync(store, JSON.stringify({ version: 1, agents: { selected, unrelated: { PRIVATE_OTHER: 'PRIVATE_RECORD' }, ...extra } }));
const page = (text = 'When to reach it: Review work\nOwns: Selected component', notes = 'Owns: PRIVATE_NOTE_OWNS\nPRIVATE_NOTES') => {
  const file = agentPagePath('selected', memory); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, renderAgentPage('PRIVATE_TITLE', { card: text, notes })); return file;
};
const disk = (folder = root): Record<string, unknown> => Object.fromEntries(fs.readdirSync(folder).sort().map((name) => { const f = path.join(folder, name), s = fs.lstatSync(f); return [name, s.isDirectory() ? { ino: s.ino, files: disk(f) } : { bytes: fs.readFileSync(f).toString('base64'), ino: s.ino, mtimeMs: s.mtimeMs }]; }));
beforeEach(() => {
  setAgentCardSource(null);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-description-display-'))); memory = path.join(root, 'memory'); store = path.join(root, 'dispatcher-agent-cards.json'); clock = Date.parse('2026-11-19T12:00:00Z');
  const unexpected = () => { throw new Error('ordinary control callback invoked by display'); };
  deps = { memoryRoot: memory, storePath: () => store, now: () => clock, activeDispatcherId: vi.fn(unexpected), dispatcherName: vi.fn(unexpected), isDispatcherPath: vi.fn(unexpected), listProjects: vi.fn(unexpected), listAgents: vi.fn(unexpected), connectedIds: vi.fn(unexpected), isWiredToDispatcher: vi.fn(unexpected), send: vi.fn(unexpected), log: vi.fn(), changed: vi.fn() };
  cards = new AgentCards(deps);
});
afterEach(() => { setAgentCardSource(null); vi.restoreAllMocks(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
it('returns only the selected card fields without ordinary cache loads, requests, callbacks, notes or unrelated rows', async () => {
  put(); page(); const status = vi.spyOn(cards, 'status'), sync = vi.spyOn(cards, 'sync'), deliver = vi.spyOn(cards, 'deliver'), before = disk();
  const result = await cards.viewForDisplay('selected', project);
  expect(result).toMatchObject({ state: 'ok', value: { view: { state: 'ready', card: { contactWhen: 'Review work', owns: 'Selected component' } }, withheld: [], truncated: [] } });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|projectPath|setup|purpose|agents|request/);
  expect.soft(status).not.toHaveBeenCalled(); expect.soft(sync).not.toHaveBeenCalled(); expect.soft(deliver).not.toHaveBeenCalled();
  for (const key of ['activeDispatcherId', 'dispatcherName', 'listProjects', 'listAgents', 'connectedIds', 'send', 'changed', 'log'] as const) expect.soft(deps[key]).not.toHaveBeenCalled();
  expect.soft(disk()).toEqual(before);
});
it('keeps a truly missing index verified empty without creating folders or initializing the ordinary cache', async () => {
  const before = disk(); expect(await cards.viewForDisplay('selected', project)).toMatchObject({ state: 'ok', value: null }); expect(disk()).toEqual(before);
  put(); page(); expect(await cards.view('selected')).toMatchObject({ state: 'ready', card: { owns: 'Selected component' } });
});
it('refuses a colliding canonical page rather than adopting another selected identity’s description', async () => {
  put(row(), { unrelated: { projectPath: path.resolve('/other'), page: '../SELECTED', connected: false } }); page('Owns: PRIVATE_AMBIGUOUS_CARD');
  const before = disk(), result = await cards.viewForDisplay('selected', project);
  expect.soft(result.state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_'); expect.soft(disk()).toEqual(before);
});
it.each(['syntax', 'array', 'large', 'version', 'project', 'connected', 'request'])('keeps %s metadata unavailable instead of verified no description', async (kind) => {
  if (kind === 'syntax') fs.writeFileSync(store, '{broken');
  else if (kind === 'array') fs.writeFileSync(store, '[]');
  else if (kind === 'version') fs.writeFileSync(store, '{"version":2,"agents":{}}');
  else if (kind === 'large') fs.writeFileSync(store, JSON.stringify({ version: 1, agents: {}, padding: 'x'.repeat(DISPLAY_CARD_INDEX_BYTES) }));
  else put(kind === 'project' ? row({ projectPath: path.resolve('/unrelated-project') }) : kind === 'connected' ? { ...row(), connected: 'false' } : row({ request: { reason: 'connect', at: 'invalid' } }));
  fs.writeFileSync(store + '.bak', '{"version":1,"agents":{}}'); const before = disk();
  expect.soft((await cards.viewForDisplay('selected', project)).state).toBe('unavailable'); expect.soft(disk()).toEqual(before); expect.soft(deps.log).not.toHaveBeenCalled();
});
it('keeps a complete small card available above large Notes, with bounded descriptor bytes and no Notes transport', async () => {
  put(); const file = page(undefined, 'PRIVATE_NOTES'.repeat(200000)); const before = disk(); let bytes = 0;
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args); if (String(args[0]) === file) {
      const read = handle.read.bind(handle); vi.spyOn(handle, 'read').mockImplementation(async (...args: Parameters<typeof read>) => { const result = await Reflect.apply(read, handle, args); bytes += result.bytesRead; return result; });
    } return handle;
  });
  syncBuiltinESMExports();
  const result = await cards.viewForDisplay('selected', project);
  expect.soft(result).toMatchObject({ state: 'ok', value: { view: { state: 'ready', card: { owns: 'Selected component' } } } });
  expect.soft(bytes).toBeGreaterThan(0); expect.soft(bytes).toBeLessThanOrEqual(DISPLAY_CARD_PREFIX_BYTES + 1); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_'); expect.soft(disk()).toEqual(before);
});
it('accepts a complete card when a multibyte character is cut only inside following Notes', async () => {
  put(); let invalidTail = false;
  for (let padding = 0; padding < 3; padding++) {
    const file = page(undefined, 'x'.repeat(padding) + '€'.repeat(50000));
    try { new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file).subarray(0, DISPLAY_CARD_PREFIX_BYTES)); }
    catch { invalidTail = true; break; }
  }
  expect(invalidTail).toBe(true);
  expect(await cards.viewForDisplay('selected', project)).toMatchObject({ state: 'ok', value: { view: { state: 'ready', card: { owns: 'Selected component' } } } });
});
it('uses the same first Card / following Notes framing for a complete hand-edited legacy page', async () => {
  put(); const file = page(); fs.writeFileSync(file, '# Title\n## Notes\nOwns: PRIVATE_EARLY_FIELD\n## Card\nOwns: Selected component\n## Notes\nOwns: PRIVATE_LATE_NOTES');
  const result = await cards.viewForDisplay('selected', project);
  expect(result).toMatchObject({ state: 'ok', value: { view: { state: 'ready', card: { owns: 'Selected component' } } } }); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it('refuses distinct-field Notes before Card rather than adopting them as selected description fields', async () => {
  put(); const file = page();
  fs.writeFileSync(file, '# Title\n## Notes\nWhen to reach it: PRIVATE_EARLY_NOTE\n## Card\nOwns: Selected component\n## Notes\nOwns: PRIVATE_LATE_NOTES');
  const result = await cards.viewForDisplay('selected', project);
  expect.soft(result.state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it('does not call a partial Notes delimiter at the exact prefix boundary a complete Card', async () => {
  put(); const file = page(), base = '# Title\n## Card\nOwns: Early component\n', tail = '\n## Notes';
  const prefix = base + ' '.repeat(DISPLAY_CARD_PREFIX_BYTES - Buffer.byteLength(base) - Buffer.byteLength(tail)) + tail;
  expect(Buffer.byteLength(prefix)).toBe(DISPLAY_CARD_PREFIX_BYTES);
  fs.writeFileSync(file, prefix + ' continuation\nWhen to reach it: Later Card field\n## Notes\nOwns: PRIVATE_REAL_NOTES');
  const result = await cards.viewForDisplay('selected', project);
  expect.soft(result.state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toMatch(/Early component|PRIVATE_/);
});
it('rejects an empty stored project path even when it would normalize to the admitted current directory', async () => {
  put(row({ projectPath: '' })); page('Owns: PRIVATE_CWD_ASSOCIATION');
  const result = await cards.viewForDisplay('selected', process.cwd());
  expect.soft(result.state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it.each(['unframed', 'safe-preface'] as const)('retains legitimate complete %s legacy Card text before Notes', async (kind) => {
  put(); const file = page();
  fs.writeFileSync(file, '# Title\nWhen to reach it: Safe legacy contact\n' + (kind === 'safe-preface' ? '## Card\n' : '') + 'Owns: Selected component\n## Notes\nWhen to reach it: PRIVATE_NOTES');
  const result = await cards.viewForDisplay('selected', project);
  expect(result).toMatchObject({ state: 'ok', value: { view: { state: 'ready', card: { contactWhen: 'Safe legacy contact', owns: 'Selected component' } } } }); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it.each(['incomplete', 'invalid-utf8', 'link', 'directory'])('withholds %s page evidence rather than returning an empty card', async (kind) => {
  put(); const file = page();
  if (kind === 'incomplete') fs.writeFileSync(file, '# Title\n## Card\n' + 'x'.repeat(DISPLAY_CARD_PREFIX_BYTES + 1));
  if (kind === 'invalid-utf8') fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00]));
  if (kind === 'link') { const outside = path.join(root, 'PRIVATE_OUTSIDE'); fs.writeFileSync(outside, 'Owns: PRIVATE_OTHER_AGENT'); fs.unlinkSync(file); fs.symlinkSync(outside, file); }
  if (kind === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
  expect((await cards.viewForDisplay('selected', project)).state).toBe('unavailable');
});
it.each(['waiting', 'asking', 'expired', 'disconnected'])('matches recorded request state=%s without delivering or arming a timer', async (kind) => {
  put(row({ connected: kind !== 'disconnected', request: { reason: 'connect', at: new Date(clock).toISOString(), ...(kind !== 'waiting' && { deliveredAt: new Date(clock - (kind === 'expired' ? NO_ANSWER_MS + 1 : 10)).toISOString() }) } }));
  const before = disk(), result = await cards.viewForDisplay('selected', project);
  expect(result).toMatchObject({ state: 'ok', value: { view: { state: kind === 'asking' ? 'asking' : 'none', card: null, ...(kind === 'waiting' && { waitingToAsk: true }) } } });
  expect(disk()).toEqual(before); expect(deps.send).not.toHaveBeenCalled(); expect(deps.changed).not.toHaveBeenCalled();
});
it('preserves independent safe fields while marking conservative withholding and truncation explicitly', async () => {
  put(); page('When to reach it: config["apiKey"]="PRIVATE_SECRET";\nOwns: ' + 'x'.repeat(700));
  const result = await cards.viewForDisplay('selected', project);
  expect.soft(result).toMatchObject({ state: 'ok', value: { view: { state: 'ready', card: { contactWhen: 'Text withheld (conservative display policy)', owns: expect.stringContaining('[text truncated]') } }, withheld: ['contactWhen'], truncated: ['owns'] } });
  expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it.each(['mapping', 'page', 'expiry', 'creation'])('carries private real selected evidence through later %s changes', async (change) => {
  if (change !== 'creation') { put(row({ request: { reason: 'connect', at: new Date(clock).toISOString(), deliveredAt: new Date(clock).toISOString() } })); if (change !== 'expiry') page(); }
  const receipts: Array<{ current(): boolean }> = []; const result = await cards.viewForDisplay('selected', project, { receipts });
  expect(result.state).toBe('ok'); expect(receipts).toHaveLength(1); expect(receipts[0].current()).toBe(true); expect(JSON.stringify(result)).not.toMatch(/receipts|current|PRIVATE_/);
  if (change === 'mapping') put(row({ page: 'unrelated' }));
  if (change === 'page') page('Owns: Changed selected component');
  if (change === 'expiry') clock += NO_ANSWER_MS + 1;
  if (change === 'creation') put();
  expect(receipts[0].current()).toBe(false);
});
it.each(['mapping', 'page', 'revocation'])('withholds a late %s change during an actual bounded page read', async (change) => {
  put(); page(); const read = files.readOnlyWorktreeFile; let allowed = true, changed = false;
  vi.spyOn(files, 'readOnlyWorktreeFile').mockImplementation(async (...args) => { const result = await read(...args); if (change === 'mapping') put(row({ projectPath: path.resolve('/other') })); else if (change === 'page') page('Owns: Changed selected component'); else allowed = false; changed = true; return result; });
  const result = await cards.viewForDisplay('selected', project, { authorized: () => allowed });
  expect(changed).toBe(true); expect.soft(result.state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toMatch(/Selected component|Review work|PRIVATE_/);
});
it('ignores unrelated index edits while detaching all returned fields from later reads', async () => {
  put(); page(AGENT_CARD_PLACEHOLDER); const receipts: Array<{ current(): boolean }> = [];
  const result = await cards.viewForDisplay('selected', project, { receipts }); expect(result).toMatchObject({ state: 'ok', value: { view: { state: 'none' } } });
  put(row(), { unrelated: { PRIVATE_OTHER: 'PRIVATE_CHANGED' } }); expect(receipts[0].current()).toBe(true);
  if (result.state === 'ok' && result.value) result.value.view.state = 'ready';
  expect(await cards.viewForDisplay('selected', project)).toMatchObject({ state: 'ok', value: { view: { state: 'none' } } });
});
it('keeps an absent/legacy source unavailable without calling the ordinary status fallback', async () => {
  const receipts: Array<{ current(): boolean }> = [];
  expect((await readAgentCardViewForDisplay('selected', project, { receipts })).state).toBe('unavailable'); expect(receipts[0].current()).toBe(true);
  const legacy: AgentCardSource = { status: vi.fn(async () => ({ state: 'ready', card: { owns: 'PRIVATE_CACHED_FIELDS' } })), saveUserCard: vi.fn() };
  setAgentCardSource(legacy); expect(receipts[0].current()).toBe(false);
  const result = await readAgentCardViewForDisplay('selected', project);
  expect.soft(result.state).toBe('unavailable'); expect.soft(legacy.status).not.toHaveBeenCalled(); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it('carries both source identity and actual selected file receipts through the passive source wrapper', async () => {
  put(); page(); const source: AgentCardSource = { status: vi.fn(), saveUserCard: vi.fn(), display: cards.viewForDisplay.bind(cards) };
  setAgentCardSource(source); const receipts: Array<{ current(): boolean }> = [];
  expect(await readAgentCardViewForDisplay('selected', project, { receipts })).toMatchObject({ state: 'ok', value: { view: { card: { owns: 'Selected component' } } } });
  expect(receipts).toHaveLength(2); expect(receipts.every((receipt) => receipt.current())).toBe(true);
  page('Owns: Changed selected component'); expect(receipts[0].current()).toBe(true); expect(receipts[1].current()).toBe(false);
  setAgentCardSource({ ...source }); expect(receipts[0].current()).toBe(false); expect(source.status).not.toHaveBeenCalled();
});
it.each(['source-replaced', 'revoked'])('drops modeled deferred source fields after %s', async (change) => {
  let release!: () => void, entered!: () => void, allowed = true;
  const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
  const source: AgentCardSource = { status: vi.fn(), saveUserCard: vi.fn(), display: async () => { entered(); await held; return { state: 'ok', value: { view: { state: 'ready', card: { owns: 'PRIVATE_LATE_SOURCE' } }, withheld: [], truncated: [] }, inputs: [] }; } };
  setAgentCardSource(source); const reading = readAgentCardViewForDisplay('selected', project, { authorized: () => allowed }); await started;
  if (change === 'source-replaced') setAgentCardSource({ ...source }); else allowed = false;
  release(); const result = await reading;
  expect.soft(result.state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_'); expect(source.status).not.toHaveBeenCalled();
});
