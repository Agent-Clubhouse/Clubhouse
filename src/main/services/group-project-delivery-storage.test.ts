/** Restart delivery with the real host, board JSON and notification receipt JSON. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const fx = vi.hoisted(() => ({ home: '', connected: undefined as undefined | ((id: string) => void), send: vi.fn(async (_text: string) => ({ delivery: 'prompt' })), alive: false }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => fx.home } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ list: async () => [] }));
vi.mock('./annex-identity', () => ({ getIdentity: () => null }));
vi.mock('./annex-settings', () => ({ networkEnabled: () => false }));
vi.mock('./group-project-tool-members', () => ({ groupProjectMentionMembers: async () => [{ address: 'dev', name: 'dev' }] }));
vi.mock('./group-project-lifecycle', () => ({ isAgentAlive: () => fx.alive }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => fx.alive ? { kind: 'chat', getState: () => 'idle', isRunning: () => true, sendMessage: fx.send } : undefined }));
vi.mock('./group-project-wake', () => ({ wakeForGroupPost: async () => false }));
vi.mock('./clubhouse-mcp/connection-events', () => ({ onAgentMcpConnected: (fn: (id: string) => void) => { fx.connected = fn; return () => { fx.connected = undefined; }; } }));
import { groupProjectHost } from './group-project-host';
import { groupProjectRegistry } from './group-project-registry';
import { _resetAllBoardsForTesting } from './group-project-bulletin';
import { _resetDeliveryForTesting, watchGroupProjectDelivery } from './group-project-delivery';
import { lastNotified } from './group-project-notification-store';
async function restart() {
  _resetDeliveryForTesting();
  await groupProjectRegistry.flush(); await groupProjectHost.flushBoards();
  groupProjectRegistry._resetForTesting(); _resetAllBoardsForTesting(); groupProjectHost._resetForTesting();
}
afterEach(async () => { await restart(); vi.restoreAllMocks(); await fsp.rm(fx.home, { recursive: true, force: true }); });
it('reconnects after loss of all delivery memory with one unread summary, then persists its receipt', async () => {
  fx.home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gp-delivery-'));
  const gp = await groupProjectHost.create('Restart');
  const first = await groupProjectHost.post(gp.id, 'qa', 'general', 'one');
  const second = await groupProjectHost.post(gp.id, 'qa', 'general', 'two');
  await restart();
  vi.spyOn(groupProjectHost, 'resolveMembers').mockResolvedValue([{ address: 'dev', name: 'dev' }]);
  fx.alive = true;
  watchGroupProjectDelivery(); fx.connected!('dev');
  await vi.waitFor(() => expect(fx.send).toHaveBeenCalledTimes(1), { timeout: 5000 });
  expect(fx.send.mock.calls[0][0]).toContain('2 new messages');
  await vi.waitFor(async () => expect(await lastNotified(gp.id, 'dev')).toBe(second.seq));
  expect(second.seq).toBeGreaterThan(first.seq!);
  await restart();
  vi.spyOn(groupProjectHost, 'resolveMembers').mockResolvedValue([{ address: 'dev', name: 'dev' }]);
  watchGroupProjectDelivery(); fx.connected!('dev');
  // A repeat connection finds no unread posts in the same persisted board.
  await new Promise((resolve) => setTimeout(resolve, 3200));
  expect(fx.send).toHaveBeenCalledTimes(1);
}, 12_000);
