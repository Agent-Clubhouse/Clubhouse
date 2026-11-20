import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { REMOTE_DETAILS_CARD_IDS, type RemoteAgentDetails } from '../../shared/remote-agent-details';
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
    expect(await readSelectedDispatcherDetails(allowed)).toEqual({ status: 200, body: { version: 1, role: 'dispatcher', agentId: 'role1', details: details() } });
    expect(m.resolve).toHaveBeenCalledExactlyOnceWith('role1', undefined, { strict: true });
    expect(m.details).toHaveBeenCalledExactlyOnceWith('role1', allowed);
    expect(await fs.readFile(primary, 'utf8')).toBe(before);
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

  it('rejects a mismatched ordinary response identity and bounds unexpected errors', async () => {
    m.details.mockResolvedValueOnce({ status: 200, body: { ...details(), agentId: 'unrelated' } });
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 500, body: { error: 'dispatcher_details_invalid' } });
    m.details.mockRejectedValueOnce(new Error('PRIVATE_PATH_AND_ERROR'));
    expect(await readSelectedDispatcherDetails(() => true)).toEqual({ status: 500, body: { error: 'dispatcher_details_failed' } });
  });
});
