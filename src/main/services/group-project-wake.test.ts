import { beforeEach, expect, it, vi } from 'vitest';
const fx = vi.hoisted(() => ({
  gp: { id: 'g', metadata: {} as Record<string, unknown>, host: { machine: 'host' } },
  config: { agentConfig: { lastSessionId: 'last' }, projectPath: '/p' } as unknown,
  decision: 'allow', reserve: vi.fn(async () => true), wake: vi.fn(),
}));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => undefined }));
vi.mock('./group-project-host', () => ({ groupProjectHost: {
  get: async () => fx.gp, resolveMembers: async () => [{ address: 'dev', name: 'dev' }],
  localAgentId: (_g: unknown, a: string) => a === 'dev' || a === 'sender' ? a : null,
} }));
vi.mock('./group-project-roles', () => ({ groupProjectMay: (_g: unknown, grant: string) => !(fx.gp.metadata[grant] === 'off') }));
vi.mock('./clubhouse-mcp/grant-check', () => ({ decideGrant: () => ({ outcome: fx.decision }) }));
vi.mock('./group-project-notification-store', () => ({ reserveWake: fx.reserve }));
vi.mock('./clubhouse-mcp/tools/agent-lifecycle', () => ({ findDurableAgentConfig: async () => fx.config, wakeWiredAgent: fx.wake }));
import { wakeForGroupPost } from './group-project-wake';
beforeEach(() => {
  fx.gp.metadata = {}; fx.config = { agentConfig: { lastSessionId: 'last' }, projectPath: '/p' };
  fx.decision = 'allow'; fx.reserve.mockResolvedValue(true);
  fx.wake.mockResolvedValue({ content: [{ type: 'text', text: '{"messageDelivered":true}' }] });
});
const wake = (sender = 'sender') => wakeForGroupPost('g', 'dev', 'dev', 'notice', [], [sender]);
it('uses the shared resume lifecycle with notice as mission', async () => {
  expect(await wake()).toBe(true);
  expect(fx.wake).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'dev', mission: 'notice' }));
});
it('holds with explicit wake off', async () => { fx.gp.metadata.wake = 'off'; expect(await wake()).toBe(false); expect(fx.wake).not.toHaveBeenCalled(); });
it('holds helpers and durables without a resumable session', async () => {
  fx.config = null; expect(await wake()).toBe(false);
  fx.config = { agentConfig: {} }; expect(await wake()).toBe(false);
  expect(fx.wake).not.toHaveBeenCalled();
});
it('holds over the wake limit', async () => { fx.reserve.mockResolvedValue(false); expect(await wake()).toBe(false); expect(fx.wake).not.toHaveBeenCalled(); });
it('allows remote lead Allow, holds Ask and off', async () => {
  expect(await wake('sender@remote')).toBe(true);
  fx.wake.mockClear();
  for (const outcome of ['ask', 'refuse']) { fx.decision = outcome; expect(await wake('sender@remote')).toBe(false); }
  expect(fx.wake).not.toHaveBeenCalled();
});
it('rechecks authorization before spawn', async () => {
  fx.wake.mockImplementationOnce(async ({ authorize }) => {
    fx.gp.metadata.wake = 'off'; await expect(authorize()).rejects.toThrow('permission');
    return { isError: true, content: [] };
  });
  expect(await wake()).toBe(false);
});
