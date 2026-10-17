import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAppLog = vi.fn();
vi.mock('./log-service', () => ({ appLog: (...args: unknown[]) => mockAppLog(...args) }));

const pending = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock('./annex-permission-queue', () => ({
  listPending: () => pending.list,
  createPermission: vi.fn(),
  PERMISSION_QUEUE_TIMEOUT_MS: 110_000,
}));

vi.mock('./agent-registry', () => ({
  getAgentProjectPath: vi.fn(),
  getAgentOrchestrator: vi.fn(),
  getAgentNonce: vi.fn(),
  resolveOrchestrator: vi.fn(),
}));
vi.mock('../orchestrators', () => ({ isHookCapable: vi.fn() }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('./annex-event-bus', () => ({ emitHookEvent: vi.fn() }));

import { scanForStuckPermissions, stop } from './hook-server';

function stuck(requestId: string, agentId = 'agent-secret-1') {
  return { requestId, agentId, toolName: 'Bash', createdAt: Date.now() - 60_000, timeoutMs: 110_000 };
}

const stuckCalls = () => mockAppLog.mock.calls.filter((c) => c[2] === 'Stuck pending permission');
const bridged = () => stuckCalls().filter((c) => (c[3] as { telemetry?: unknown }).telemetry);

beforeEach(() => {
  stop();
  mockAppLog.mockClear();
  pending.list = [];
});

describe('scanForStuckPermissions telemetry', () => {
  it('bridges each stuck request once with only the agent id as a hash attr, but logs every scan', () => {
    pending.list = [stuck('req-1')];
    scanForStuckPermissions();
    scanForStuckPermissions();
    scanForStuckPermissions();
    expect(stuckCalls()).toHaveLength(3);
    expect(bridged()).toHaveLength(1);
    const telemetry = (bridged()[0][3] as { telemetry: unknown }).telemetry;
    expect(telemetry).toEqual({
      event: 'clubhouse.agent.permission.stuck',
      // kind 'hash': the export pipeline salts and hashes the raw id before it leaves.
      attrs: [{ key: 'clubhouse.agent.id_hash', kind: 'hash', value: 'agent-secret-1' }],
    });
    expect(JSON.stringify(telemetry)).not.toMatch(/Bash|req-1/);
  });

  it('bridges a second stuck request separately', () => {
    pending.list = [stuck('req-1')];
    scanForStuckPermissions();
    pending.list = [stuck('req-1'), stuck('req-2')];
    scanForStuckPermissions();
    expect(bridged()).toHaveLength(2);
  });

  it('forgets a request once it leaves the queue', () => {
    pending.list = [stuck('req-1')];
    scanForStuckPermissions();
    pending.list = [];
    scanForStuckPermissions();
    // The same id coming back (a test-only scenario; real ids are UUIDs) is reported again.
    pending.list = [stuck('req-1')];
    scanForStuckPermissions();
    expect(bridged()).toHaveLength(2);
  });

  it('ignores requests younger than the stuck threshold', () => {
    pending.list = [{ ...stuck('req-1'), createdAt: Date.now() }];
    scanForStuckPermissions();
    expect(stuckCalls()).toHaveLength(0);
  });
});
