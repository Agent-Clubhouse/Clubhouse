/** Separately authorized zero-token QA only: clean env + OS loopback-only sandbox required. */
import { expect, it } from 'vitest';
import { copilotProtocolRecovery } from './compatibility';
import { CopilotSdkChatDriver } from './driver';

it('checks the explicitly selected CLI protocol without a session or prompt', async () => {
  // No implicit SDK-bundled runtime: the caller must identify the binary under test.
  const binary = process.env.CLUBHOUSE_COPILOT_HANDSHAKE_BINARY;
  if (!binary) throw new Error('Set CLUBHOUSE_COPILOT_HANDSHAKE_BINARY to the installed Copilot CLI (or an explicitly labeled SDK platform runtime).');
  const credentialKeys = Object.keys(process.env).filter((key) => /^(?:GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|COPILOT_PROVIDER_.*)$/i.test(key));
  expect(credentialKeys).toEqual([]);
  let protocol: number | undefined;
  const driver = new CopilotSdkChatDriver({ log: (_level, message, meta) => {
    if (message === 'Copilot SDK probe') protocol = meta?.protocolVersion as number;
  } });
  // This QA entry has no session/start/send call. The surrounding sandbox,
  // not fake tokens, enforces the outbound-network boundary.
  const result = await driver.probe(binary);
  if (!result.handshakeOk) protocol = Number(/server reports version (\d+)/.exec(result.error ?? '')?.[1]);
  const recovery = result.handshakeOk ? undefined : copilotProtocolRecovery(result.error ?? '');
  console.log(JSON.stringify({ binary, protocol, ...result, ...(recovery && { recovery }) }));
  expect(Number.isInteger(protocol) && protocol > 0).toBe(true);
  const expected = process.env.CLUBHOUSE_COPILOT_HANDSHAKE_PROTOCOL;
  if (expected) expect(protocol).toBe(Number(expected));
  if (protocol === 4) {
    expect(result).toMatchObject({ handshakeOk: true, needsLogin: true });
    const version = process.env.CLUBHOUSE_COPILOT_HANDSHAKE_VERSION;
    if (version) expect(result.cliVersion).toBe(version);
  } else {
    expect(result).toMatchObject({ handshakeOk: false, errorCode: 'protocol_error' });
    if (protocol < 4) {
      expect(recovery).toContain('Copilot CLI 1.0.113 or a newer protocol-4 release');
      expect(recovery).toContain('Update your installed Copilot CLI');
    }
  }
}, 30_000);
