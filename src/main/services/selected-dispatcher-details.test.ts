import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { isRemoteAgentDetails, REMOTE_DETAILS_CARD_IDS, REMOTE_DETAILS_MAX_BYTES, type RemoteAgentDetails } from '../../shared/remote-agent-details';
import { isSelectedDispatcherDetails } from '../../shared/selected-dispatcher-details';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { readSelectedDispatcherDetails } from './selected-dispatcher-details';

const m = vi.hoisted(() => ({ root: '', roleId: 'role1' as string | null, resolve: vi.fn(), details: vi.fn(), forbidden: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.root }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => m.roleId, getDispatcherChatAgentId: () => 'chat1' }));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.resolve }));
vi.mock('./remote-agent-details', () => ({ readRemoteAgentDetails: m.details }));
// These unrelated active/relationship ports must never be used by the canonical selector.
vi.mock('./dispatcher/dispatcher-settings', () => ({ readDispatcherEnablementForDisplay: m.forbidden }));
vi.mock('./dispatcher/dispatcher-agent-card-source', () => ({ readAgentCardViewForDisplay: m.forbidden }));
vi.mock('./agent-grants-service', () => ({ readAgentReachForDisplay: m.forbidden }));

const agent = { id: 'role1', name: 'Host Dispatcher', orchestrator: 'claude-code' };
const details = (): RemoteAgentDetails => ({ version: 1, agentId: 'role1', readOnly: true, readAt: 1, providerId: 'claude-code', running: false, status: 'sleeping', spawnedAt: null,
  sessionId: null, nativeSessionId: null, settings: null, cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: 1 })) });
let primary: string;
beforeEach(async () => {
  m.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-selected-dispatcher-')));
  m.roleId = 'role1';
  const folder = path.join(m.root, 'dispatcher');
  await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
  primary = path.join(folder, '.clubhouse', 'agents.json');
  await fs.writeFile(primary, JSON.stringify([agent]));
  m.resolve.mockResolvedValue({ agent, project: { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: folder } });
  m.details.mockResolvedValue({ status: 200, body: details() });
});
afterEach(async () => {
  expect(m.forbidden).not.toHaveBeenCalled();
  await fs.rm(m.root, { recursive: true, force: true });
});

// The usable inner budget: the cap less the serialized UTF-8 bytes the role wrapper adds around `details`.
const budgetFor = (agentId: string) => REMOTE_DETAILS_MAX_BYTES - (Buffer.byteLength(JSON.stringify({ version: 1, role: 'dispatcher', agentId, details: null })) - Buffer.byteLength('null'));
// A valid Details body padded to exactly `bytes` serialized UTF-8 bytes (rows stay within the validator's limits).
const sized = (agentId: string, bytes: number): RemoteAgentDetails => {
  const body: RemoteAgentDetails = { ...details(), agentId };
  const size = () => Buffer.byteLength(JSON.stringify(body));
  const fillable = body.cards.filter((c) => c.id !== 'settings');
  outer: for (const card of fillable) {
    while (card.rows.length < 100) {
      const room = bytes - size() - Buffer.byteLength(JSON.stringify({ label: 'pad', value: '' })) - (card.rows.length ? 1 : 0);
      if (room <= 0) break outer;
      card.rows.push({ label: 'pad', value: 'x'.repeat(Math.min(2000, room)) });
    }
  }
  const gap = bytes - size();
  if (gap < 0) throw new Error('fixture overshoot');
  if (gap > 0) { const last = fillable.flatMap((c) => c.rows).at(-1)!; last.value += 'x'.repeat(gap); if (last.value.length > 2048) throw new Error('fixture row too long'); }
  if (size() !== bytes) throw new Error(`fixture size ${size()} != ${bytes}`);
  return body;
};
describe('staged selected-host Dispatcher Details', () => {
  it('refuses an anonymous call or a refused desktop gate before role or ordinary Details reads', async () => {
    expect(await readSelectedDispatcherDetails()).toEqual({ status: 403, body: { error: 'details_read_refused' } });
    // Principal policy stays in the existing adapter gate; a refused principal cannot discover a role here.
    expect(await readSelectedDispatcherDetails(() => false)).toEqual({ status: 403, body: { error: 'details_read_refused' } });
    expect(m.resolve).not.toHaveBeenCalled(); expect(m.details).not.toHaveBeenCalled();
  });

  it('delegates the exact canonical primary target to ordinary Details under the same gate', async () => {
    const allowed = vi.fn(() => true);
    const before = await fs.readFile(primary, 'utf8');
    const result = await readSelectedDispatcherDetails(allowed);
    expect(result.body).toEqual({ version: 1, role: 'dispatcher', agentId: 'role1', details: details() });
    expect(result.status).toBe(200);
    expect(result.receipt?.current()).toBe(true);
    expect(JSON.stringify(result.body)).not.toMatch(/receipt|current|dispatcher-chat/);
    expect(m.resolve).toHaveBeenCalledExactlyOnceWith('role1', undefined, { strict: true });
    expect(m.details).toHaveBeenCalledExactlyOnceWith('role1', allowed, undefined, { maxBytes: budgetFor('role1') });
    expect(await fs.readFile(primary, 'utf8')).toBe(before);
  });

  it('pages the host-selected role Connections only, validating the page against the query', async () => {
    const allowed = vi.fn(() => true);
    const query = { card: 'connections' as const, source: 'outgoing' as const, offset: 0, projectOffset: 0 };
    const pageBody = (source = 'outgoing', offset = 0): RemoteAgentDetails => ({ ...details(), connectionPageEnvelope: 1, connectionPageOnly: true, connectionPages: 1,
      cards: details().cards.map((c) => c.id === 'connections' ? { ...c, connectionPage: { source, offset, projectOffset: 0, next: null, known: 0, complete: true } } : { ...c, requested: false }) } as RemoteAgentDetails);
    m.details.mockResolvedValue({ status: 200, body: pageBody() });
    const result = await readSelectedDispatcherDetails(allowed, query);
    expect(result.status).toBe(200); expect(result.body).toEqual({ version: 1, role: 'dispatcher', agentId: 'role1', details: pageBody() });
    expect(m.details).toHaveBeenCalledExactlyOnceWith('role1', allowed, query, { maxBytes: budgetFor('role1') });
    for (const wrong of [pageBody('incoming'), pageBody('outgoing', 25), details()]) {
      m.details.mockResolvedValue({ status: 200, body: wrong });
      expect(await readSelectedDispatcherDetails(allowed, query)).toEqual({ status: 500, body: { error: 'dispatcher_details_invalid' } });
    }
    m.details.mockClear();
    for (const bad of [{ card: 'orchestrate', source: 'helpers' }, { card: 'actions', source: 'selected-action-relationships' }, { card: 'connections', source: 'nope' }]) {
      expect(await readSelectedDispatcherDetails(allowed, bad as never)).toEqual({ status: 400, body: { error: 'invalid_dispatcher_details_query' } });
    }
    expect(m.details).not.toHaveBeenCalled(); expect(m.resolve).toHaveBeenCalledTimes(4);
    expect(await readSelectedDispatcherDetails(() => false, { card: 'orchestrate', source: 'helpers' } as never)).toEqual({ status: 403, body: { error: 'details_read_refused' } });
    // A page body is never accepted as the whole role read.
    m.details.mockResolvedValue({ status: 200, body: pageBody() });
    expect(await readSelectedDispatcherDetails(allowed)).toEqual({ status: 500, body: { error: 'dispatcher_details_invalid' } });
  });

  describe('role wrapper byte budget (M1)', () => {
    // A producer that fills whatever budget it is given, as readRemoteAgentDetails trims up to it.
    const filling = (id: string) => m.details.mockImplementation(async (_id: string, _allowed: unknown, _query: unknown, options?: { maxBytes?: number }) => ({ status: 200, body: sized(id, options?.maxBytes ?? REMOTE_DETAILS_MAX_BYTES) }));

    it.each(['role1', 'rôle "quoted" \\ 名前'])('fits a producer-filled inner body exactly inside the cap for agent id %j', async (id) => {
      m.roleId = id; m.resolve.mockResolvedValue({ agent: { ...agent, id }, project: { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: path.dirname(path.dirname(primary)) } });
      await fs.writeFile(primary, JSON.stringify([{ ...agent, id }]));
      filling(id);
      const result = await readSelectedDispatcherDetails(() => true);
      expect(result.status).toBe(200);
      expect(Buffer.byteLength(JSON.stringify(result.body))).toBe(REMOTE_DETAILS_MAX_BYTES);
      expect(m.details).toHaveBeenCalledWith(id, expect.any(Function), undefined, { maxBytes: budgetFor(id) });
    });

    it('passes the same budget for a role Connections page', async () => {
      const query = { card: 'connections' as const, source: 'outgoing' as const, offset: 0, projectOffset: 0 };
      m.details.mockResolvedValue({ status: 200, body: details() });
      await readSelectedDispatcherDetails(() => true, query);
      expect(m.details).toHaveBeenCalledExactlyOnceWith('role1', expect.any(Function), query, { maxBytes: budgetFor('role1') });
    });

    it('keeps the outer cap: an inner body one byte over the budget is refused, not sent', async () => {
      m.details.mockResolvedValue({ status: 200, body: sized('role1', budgetFor('role1') + 1) });
      expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 500, body: { error: 'dispatcher_details_limit' } });
      m.details.mockResolvedValue({ status: 200, body: sized('role1', budgetFor('role1')) });
      expect((await readSelectedDispatcherDetails(() => true)).status).toBe(200);
    });

    it('passes a producer refusal through unchanged', async () => {
      m.details.mockResolvedValue({ status: 500, body: { error: 'details_limit' } });
      expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 500, body: { error: 'details_limit' } });
    });
  });

  it('keeps an unbound canonical role unavailable without lookup, fallback, enablement or creation', async () => {
    m.roleId = null;
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 404, body: { error: 'dispatcher_role_unavailable' } });
    expect(m.resolve).not.toHaveBeenCalled(); expect(m.details).not.toHaveBeenCalled();
  });

  it.each(['unreadable', 'backup-only', 'disposed', 'wrong-folder'] as const)('keeps failed passive primary admission unavailable: %s', async (mode) => {
    if (mode === 'unreadable') await fs.writeFile(primary, '{broken');
    if (mode === 'backup-only') await fs.rename(primary, `${primary}.bak`);
    if (mode === 'disposed') await fs.writeFile(primary, JSON.stringify([{ ...agent, disposedAt: '2026-11-20' }]));
    if (mode === 'wrong-folder') m.resolve.mockResolvedValue({ agent, project: { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: path.join(m.root, 'dispatcher-chat') } });
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 404, body: { error: 'dispatcher_role_unavailable' } });
    expect(m.details).not.toHaveBeenCalled();
    if (mode === 'backup-only') {
      await expect(fs.access(primary)).rejects.toThrow();
      expect(await fs.readFile(`${primary}.bak`, 'utf8')).toBe(JSON.stringify([agent]));
    }
  });

  it('rejects role replacement during passive admission before any Details read', async () => {
    m.resolve.mockImplementation(async () => {
      m.roleId = 'replacement';
      return { agent, project: { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: path.join(m.root, 'dispatcher') } };
    });
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 409, body: { error: 'dispatcher_role_changed' } });
    expect(m.details).not.toHaveBeenCalled();
  });

  it.each(['role', 'primary-revision', 'removed', 'revoked'] as const)('withholds ordinary Details after an asynchronous final receipt changes: %s', async (mode) => {
    let allowed = true;
    m.details.mockImplementation(async () => {
      if (mode === 'role') m.roleId = null;
      if (mode === 'primary-revision') await fs.writeFile(primary, JSON.stringify([{ ...agent, name: 'Updated revision' }]));
      if (mode === 'removed') await fs.writeFile(primary, '[]');
      if (mode === 'revoked') allowed = false;
      return { status: 200, body: details() };
    });
    const result = await readSelectedDispatcherDetails(() => allowed);
    expect(result).toEqual(mode === 'revoked' ? { status: 403, body: { error: 'details_read_refused' } } : { status: 409, body: { error: 'dispatcher_role_changed' } });
    expect(JSON.stringify(result.body)).not.toContain('claude-code');
  });

  it('preserves an ordinary Details refusal instead of retrying a controller or mobile read', async () => {
    m.details.mockResolvedValue({ status: 403, body: { error: 'details_read_refused' } });
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 403, body: { error: 'details_read_refused' } });
    expect(m.details).toHaveBeenCalledTimes(1);
  });

  it('rejects a managed inventory-page-only response even before that additive page type is known locally', async () => {
    m.details.mockResolvedValue({ status: 200, body: { ...details(), inventoryPageOnly: true } });
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 500, body: { error: 'dispatcher_details_invalid' } });
  });

  it('rejects a selected helper-page-only envelope instead of presenting it as full Dispatcher Details', async () => {
    m.details.mockResolvedValue({ status: 200, body: { ...details(), helperPageOnly: true } });
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 500, body: { error: 'dispatcher_details_invalid' } });
  });

  it('rejects a mismatched ordinary response identity and bounds unexpected errors', async () => {
    m.details.mockResolvedValueOnce({ status: 200, body: { ...details(), agentId: 'unrelated' } });
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 500, body: { error: 'dispatcher_details_invalid' } });
    m.details.mockRejectedValueOnce(new Error('PRIVATE_PATH_AND_ERROR'));
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 500, body: { error: 'dispatcher_details_failed' } });
  });
});

// #14 role Actions paging (contract 0853da899). RED-first fixtures: they fail until the role path accepts the Actions query.
describe('role Actions relationship pages (#14, RED-first)', () => {
  const allowed = () => true, selection = 'b'.repeat(64);
  const query = (offset = 0) => ({ card: 'actions' as const, source: 'selected-action-relationships' as const, offset, ...(offset && { selection }) });
  // A valid page-only body; `bytes` pads row text (6-byte lone-surrogate escapes, then ASCII) to that exact serialized size.
  const actionsPage = (agentId: string, offset = 0, bytes?: number): RemoteAgentDetails => {
    const total = offset + 30, count = Math.min(25, total - offset);
    const rows = Array.from({ length: count }, (_, i) => ({ key: (i.toString(16).padStart(2, '0')).repeat(32), name: `Made ${offset + i}`, group: 'dispatcher' as const, enabled: false, description: 'Once → Message Dispatcher' }));
    const body = { ...details(), agentId, inventoryPages: 1 as const, inventorySources: ['selected-action-relationships' as const], inventoryPageOnly: true as const,
      cards: details().cards.map((c) => ({ ...c, summary: c.id === 'actions' ? 'Selected recorded inventory page' : 'Not included in this selected inventory page', ...(c.id !== 'actions' && { requested: false as const }) })),
      inventoryPage: { version: 1 as const, source: 'selected-action-relationships' as const, state: 'recorded' as const, offset, selection, next: offset + count < total ? offset + 25 : null, totalRelationships: total, uniqueActions: total, rows, observedAt: 1, notes: [] } } as RemoteAgentDetails;
    if (bytes === undefined) return body;
    const size = () => Buffer.byteLength(JSON.stringify(body));
    for (const row of rows) {
      const room = 2048 - row.description.length, wide = Math.min(room, Math.floor((bytes - size()) / 6));
      row.description += '\ud800'.repeat(wide);
      row.description += 'x'.repeat(Math.min(room - wide, bytes - size()));
      if (size() >= bytes) break;
    }
    if (size() !== bytes) throw new Error(`fixture size ${size()} != ${bytes}`);
    return body;
  };

  it('builds valid page-only fixtures, including at the budget (fixture check, passes today)', () => {
    for (const body of [actionsPage('role1', 0), actionsPage('role1', 25), actionsPage('role1', 0, budgetFor('role1'))]) {
      expect(isRemoteAgentDetails(body, 'role1')).toBe(true);
      expect(isSelectedDispatcherDetails({ version: 1, role: 'dispatcher', agentId: 'role1', details: body })).toBe(false);
    }
    expect(Buffer.byteLength(JSON.stringify(actionsPage('role1', 0, budgetFor('role1'))))).toBe(budgetFor('role1'));
  });

  it('pages the host-selected role with the same wrapper budget and binds the page to the role agent', async () => {
    for (const offset of [0, 25]) {
      m.details.mockClear(); m.details.mockResolvedValue({ status: 200, body: actionsPage('role1', offset) });
      const result = await readSelectedDispatcherDetails(allowed, query(offset) as never);
      expect(result).toMatchObject({ status: 200, body: { version: 1, role: 'dispatcher', agentId: 'role1', details: actionsPage('role1', offset) } });
      expect(m.details).toHaveBeenCalledExactlyOnceWith('role1', allowed, query(offset), { maxBytes: budgetFor('role1') });
    }
  });

  it('rejects a page that does not answer the request: other offset, other selection or a whole read', async () => {
    const other = actionsPage('role1', 0); (other.inventoryPage as { selection: string }).selection = 'c'.repeat(64);
    for (const wrong of [actionsPage('role1', 25), other, details()]) {
      m.details.mockResolvedValue({ status: 200, body: wrong });
      expect(await readSelectedDispatcherDetails(allowed, query(0) as never)).toEqual({ status: 500, body: { error: 'dispatcher_details_invalid' } });
    }
  });

  it.each(['role1', 'rôle "quoted" \\ 名前'])('serves a role Actions page exactly at the wrapper budget and refuses one byte over (M1 boundary now reachable) for %j', async (id) => {
    m.roleId = id; m.resolve.mockResolvedValue({ agent: { ...agent, id }, project: { id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: path.dirname(path.dirname(primary)) } });
    await fs.writeFile(primary, JSON.stringify([{ ...agent, id }]));
    m.details.mockResolvedValue({ status: 200, body: actionsPage(id, 0, budgetFor(id)) });
    const exact = await readSelectedDispatcherDetails(allowed, query(0) as never);
    expect(exact.status).toBe(200); expect(Buffer.byteLength(JSON.stringify(exact.body))).toBe(REMOTE_DETAILS_MAX_BYTES);
    m.details.mockResolvedValue({ status: 200, body: actionsPage(id, 0, budgetFor(id) + 1) });
    expect(await readSelectedDispatcherDetails(allowed, query(0) as never)).toEqual({ status: 500, body: { error: 'dispatcher_details_limit' } });
  });

  it('passes the producer closed failure for an irreducible page through unchanged', async () => {
    m.details.mockResolvedValue({ status: 500, body: { error: 'details_read_failed' } });
    expect(await readSelectedDispatcherDetails(allowed, query(0) as never)).toEqual({ status: 500, body: { error: 'details_read_failed' } });
  });

  it('refuses mixed, extra or other-source keys before any role lookup', async () => {
    m.resolve.mockClear();
    for (const bad of [{ ...query(0), projectOffset: 0 }, { ...query(25), selection: undefined }, { ...query(0), selection: 'XYZ' }, { ...query(0), offset: 30 }, { card: 'canvases', source: 'selected-canvas-memberships' }]) {
      expect(await readSelectedDispatcherDetails(allowed, bad as never)).toEqual({ status: 400, body: { error: 'invalid_dispatcher_details_query' } });
    }
    expect(m.resolve).not.toHaveBeenCalled(); expect(m.details).not.toHaveBeenCalled();
  });
});
