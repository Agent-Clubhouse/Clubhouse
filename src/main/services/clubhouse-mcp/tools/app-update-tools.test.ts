import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  request: vi.fn(),
  handler: undefined as ((agentId: string, args: Record<string, unknown>) => Promise<unknown>) | undefined,
}));
vi.mock('../../app-update-request', () => ({ requestAppUpdate: fake.request }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../tool-registry', () => ({
  registerGlobalTool: (_name: string, _definition: unknown, handler: typeof fake.handler) => { fake.handler = handler; },
}));

import { registerAppUpdateTools } from './app-update-tools';
import { appLog } from '../../log-service';
import { MobileControlError } from '../../mobile-control';

beforeEach(() => {
  vi.clearAllMocks();
  registerAppUpdateTools();
});

describe('update request diagnostics', () => {
  it('keeps unexpected exception text in local logs, not the tool result', async () => {
    const diagnostic = '/Users/private-update-user/update.zip https://updates.example.invalid/private-updater-token';
    fake.request.mockRejectedValueOnce(new Error(diagnostic));
    const result = await fake.handler!('dispatcher', {});
    expect(result).toEqual({
      content: [{ type: 'text', text: 'The update request could not be prepared. Try again on the desktop.' }],
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain('private-update-user');
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).toContain(diagnostic);
  });

  it('preserves the fixed explanation for an expected refusal', async () => {
    fake.request.mockRejectedValueOnce(new MobileControlError('update_not_ready', 409, 'rejected', 'Wait until the update is ready to install.'));
    expect(await fake.handler!('dispatcher', {})).toMatchObject({
      content: [{ text: 'Wait until the update is ready to install.' }], isError: true,
    });
  });
});
