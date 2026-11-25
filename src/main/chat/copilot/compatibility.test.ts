import { describe, expect, it } from 'vitest';
import { copilotProtocolRecovery } from './compatibility';

describe('Copilot protocol recovery', () => {
  it('tells older Clubhouse builds to update their embedded SDK for a protocol-4 CLI', () => {
    const message = copilotProtocolRecovery('SDK protocol version mismatch: SDK supports versions 3-3, but server reports version 4');
    expect(message).toContain('Update Clubhouse');
    expect(message).toContain('@microsoft/copilot-sdk 2.0.2 (protocol 4)');
    expect(message).toContain('Installing an SDK globally does not change');
    expect(message).not.toMatch(/restart|login/i);
  });
  it('identifies the v4 pair and older v3 pair without asking users to reset state', () => {
    const message = copilotProtocolRecovery('SDK protocol version mismatch: SDK supports versions 4-4, but server reports version 3');
    expect(message).toContain('Copilot CLI 1.0.113');
    expect(message).toContain('Update your installed Copilot CLI');
    expect(message).toContain('@github/copilot-sdk 1.x');
    expect(message).toContain('sessions and configuration are preserved');
    expect(message).not.toMatch(/restart|login/i);
  });
  it('gives a supported pair when a future or missing protocol is reported', () => {
    expect(copilotProtocolRecovery('SDK protocol version mismatch: SDK supports versions 4-4, but server reports version 99')).toContain('matching protocol versions');
    expect(copilotProtocolRecovery('SDK protocol version mismatch: server does not report a protocol version')).toContain('protocol 4');
    expect(copilotProtocolRecovery('Connection refused')).toBeUndefined();
  });
});
