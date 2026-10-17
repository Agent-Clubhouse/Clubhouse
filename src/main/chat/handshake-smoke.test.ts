/**
 * Zero-token handshake smoke against REAL installed CLIs, for the nightly
 * real-CLI workflow (docs/structured-chat-research.md §8 decision 4). Each
 * chat driver's probe() spawns the CLI, completes the protocol handshake
 * (Claude's `initialize` control request, Codex app-server `initialize`, ACP
 * `initialize`) and exits. No prompt is ever sent, so no tokens are spent.
 *
 * Skipped unless CLUBHOUSE_CHAT_HANDSHAKE_SMOKE=1.
 *   CLUBHOUSE_CHAT_HANDSHAKE_PROVIDERS  comma list of provider ids (default: all three)
 *   CLUBHOUSE_CHAT_HANDSHAKE_REPORT     write a JSON report here (for the job summary)
 */
import * as fs from 'fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChatDriver } from '../../shared/chat';
import { getProvider, registerBuiltinProviders, type OrchestratorId } from '../orchestrators';
import { CodexChatDriver } from '../orchestrators/adapters/codex-chat-driver';
import { createCopilotAcpChatDriver } from '../orchestrators/adapters/acp-chat-driver';
import { evaluateCliVersion, TESTED_CLI_VERSIONS } from '../services/agent-runtime/chat-version-policy';
import { ClaudeChatDriver } from './claude';

const enabled = process.env.CLUBHOUSE_CHAT_HANDSHAKE_SMOKE === '1';
const PROBE_TIMEOUT_MS = 90_000;

const DRIVERS: Record<string, () => ChatDriver[]> = {
  'claude-code': () => [new ClaudeChatDriver('claude_agent_sdk'), new ClaudeChatDriver('claude_stream_json')],
  'codex-cli': () => [new CodexChatDriver()],
  'copilot-cli': () => [createCopilotAcpChatDriver()],
};

const providers = (process.env.CLUBHOUSE_CHAT_HANDSHAKE_PROVIDERS ?? Object.keys(DRIVERS).join(','))
  .split(',').map((p) => p.trim()).filter(Boolean);

interface ReportRow {
  provider: string;
  driver: string;
  binary?: string;
  handshakeOk: boolean;
  cliVersion?: string;
  versionStatus?: string;
  testedMax?: string;
  error?: string;
  ms: number;
}
const report: ReportRow[] = [];

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms).unref())]);
}

describe.skipIf(!enabled)('chat handshake smoke (real CLIs, zero tokens)', () => {
  registerBuiltinProviders();

  afterAll(() => {
    const out = process.env.CLUBHOUSE_CHAT_HANDSHAKE_REPORT;
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  });

  for (const providerId of providers) {
    const make = DRIVERS[providerId];
    if (!make) {
      it(`${providerId}: known provider`, () => {
        throw new Error(`No chat drivers for provider '${providerId}' (known: ${Object.keys(DRIVERS).join(', ')})`);
      });
      continue;
    }
    for (const driver of make()) {
      it(`${providerId} / ${driver.id}: handshake without a prompt`, async () => {
        const t0 = Date.now();
        const row: ReportRow = { provider: providerId, driver: driver.id, handshakeOk: false, ms: 0 };
        report.push(row);
        try {
          const provider = getProvider(providerId as OrchestratorId);
          if (!provider?.getBinaryPath) throw new Error(`provider ${providerId} has no binary lookup`);
          row.binary = provider.getBinaryPath();
          const probe = await withTimeout(driver.probe(row.binary, { ...process.env } as Record<string, string>), PROBE_TIMEOUT_MS, 'probe');
          row.handshakeOk = probe.handshakeOk;
          row.cliVersion = probe.cliVersion;
          row.error = probe.error;
          const verdict = evaluateCliVersion(driver.id, providerId, probe.cliVersion);
          row.versionStatus = verdict.status;
          row.testedMax = TESTED_CLI_VERSIONS[driver.id]?.testedMax;
        } catch (err) {
          row.error = err instanceof Error ? err.message : String(err);
        } finally {
          row.ms = Date.now() - t0;
        }
        expect(row.error ?? null, `${driver.id} handshake failed`).toBeNull();
        expect(row.handshakeOk).toBe(true);
      }, PROBE_TIMEOUT_MS + 10_000);
    }
  }
});
