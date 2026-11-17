/** Separately authorized zero-token QA only: clean env + OS loopback-only sandbox required. */
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { CopilotSdkChatDriver } from './driver';

it('negotiates protocol 4 with the paired CLI 1.0.113 without a session or prompt', async () => {
  // This QA entry deliberately has no session/start/send call. The surrounding
  // sandbox, not fake tokens, enforces the outbound-network boundary.
  const credentialKeys = Object.keys(process.env).filter((key) => /^(?:GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|COPILOT_PROVIDER_.*)$/i.test(key));
  expect(credentialKeys).toEqual([]);
  const platform = `${process.platform}-${process.arch}`;
  const runtime = path.resolve(__dirname, '../../../../node_modules/@microsoft', `copilot-sdk-${platform}`, 'prebuilds', platform, process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime');
  const protocols: unknown[] = [];
  const driver = new CopilotSdkChatDriver({ log: (_level, message, meta) => {
    if (message === 'Copilot SDK probe') protocols.push(meta?.protocolVersion);
  } });
  const result = await driver.probe(runtime);
  expect(result).toMatchObject({ handshakeOk: true, cliVersion: '1.0.113', needsLogin: true });
  expect(protocols).toEqual([4]);
}, 30_000);
