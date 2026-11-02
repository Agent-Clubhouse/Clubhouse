/**
 * The context choice (#2660) against REAL installed CLIs and a FAKE model
 * endpoint: real CLI, real chat driver, stand-in model. No request can reach a
 * paid model: the CLI gets a temp home, a made-up key and a base URL on
 * 127.0.0.1. Pins what each CLI does with the choice at start and on resume.
 *
 * Skipped unless CLUBHOUSE_FAKE_MODEL_SMOKE=1.
 *   CLUBHOUSE_FAKE_MODEL_BIN_DIR    folder holding the CLI binaries under test
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatDriver, ChatDriverSession, ChatDriverStartOptions } from '../../shared/chat';
import { startFakeModelServer, type FakeModelServer } from './testing/fake-model-server';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(os.tmpdir(), `clubhouse-fake-model-${name}`), getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
}));
// The login shell's env holds the user's real keys; the CLI gets none of it.
vi.mock('../util/shell', async (importOriginal) => ({
  ...await importOriginal<typeof import('../util/shell')>(),
  getShellEnvironment: () => ({ PATH: process.env.PATH ?? '', USER: 'fake', SHELL: '/bin/sh' }),
}));

import { ClaudeChatDriver } from './claude';
import { CopilotSdkChatDriver } from './copilot/driver';
import { CodexChatDriver } from '../orchestrators/adapters/codex-chat-driver';
import { createCopilotAcpChatDriver } from '../orchestrators/adapters/acp-chat-driver';

const enabled = process.env.CLUBHOUSE_FAKE_MODEL_SMOKE === '1';
const TURN_MS = 90_000;

function binary(name: string): string {
  const dir = process.env.CLUBHOUSE_FAKE_MODEL_BIN_DIR;
  if (!dir) throw new Error('Set CLUBHOUSE_FAKE_MODEL_BIN_DIR');
  return path.join(dir, name);
}

class Driven {
  readonly events: Array<{ type: string; data?: any }> = [];
  private done: Promise<void>;
  constructor(readonly session: ChatDriverSession) {
    this.done = (async () => { for await (const ev of session.events) this.events.push(ev as { type: string; data?: any }); })();
  }
  ended() { return this.events.filter((e) => e.type === 'turn_ended').length; }
  async turn(): Promise<void> {
    const before = this.ended();
    await this.session.send([{ type: 'text', text: 'hi' }], 'prompt');
    await vi.waitFor(() => expect(this.ended()).toBeGreaterThan(before), { timeout: TURN_MS, interval: 100 });
  }
  limits() { return this.events.filter((e) => e.type === 'session_info' && e.data?.contextLimits).at(-1)?.data.contextLimits; }
  usageSize() { return this.events.filter((e) => e.type === 'usage' && e.data?.context).at(-1)?.data.context.size; }
  nativeId(): string { return this.session.nativeSessionId!; }
  async close() { await this.session.close(); await this.done; }
}

describe.skipIf(!enabled)('Context choice (real CLI, fake model)', () => {
  let model: FakeModelServer;
  let root: string;
  beforeAll(async () => {
    model = await startFakeModelServer();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-window-smoke-')));
  });
  afterAll(async () => {
    await model?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  const base = (home: string) => ({ PATH: process.env.PATH ?? '', USER: 'fake', HOME: home });
  const setup = () => ({ home: fs.mkdtempSync(path.join(root, 'home-')), cwd: fs.mkdtempSync(path.join(root, 'cwd-')) });
  const starter = (driver: ChatDriver, provider: string, bin: string, cwd: string, env: Record<string, string>, extra: Partial<ChatDriverStartOptions>) =>
    async (more: Partial<ChatDriverStartOptions> = {}) => new Driven(await driver.start({
      agentId: `ctx-${driver.id}`, provider, cwd, binaryPath: binary(bin), level: 'full_access', env, ...extra, ...more,
    }));

  describe.each([['claude_agent_sdk' as const], ['claude_stream_json' as const]])('Claude Code / %s', (transport) => {
    it('sets the working window at start and resume, leaves the model alone, and is not sticky', async () => {
      const { home, cwd } = setup();
      const env = { ...base(home), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: 'fake-key-for-a-local-server', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
      const start = starter(new ClaudeChatDriver(transport), 'claude-code', 'claude', cwd, env, { model: 'claude-opus-5-5' });

      let chat = await start({ contextWindow: '300000' });
      const before = model.requests.length;
      await vi.waitFor(() => expect(chat.limits()).toMatchObject({ effectiveTokens: 300000, compactAtTokens: 267000, reservedTokens: 33000 }), { timeout: 20_000, interval: 100 });
      // Reading the limits sends nothing to the model.
      expect(model.requests.length).toBe(before);
      await chat.turn();
      // Fill is measured against the working window, not the model's 1M.
      expect(chat.usageSize()).toBe(300000);
      const id = chat.nativeId();
      await chat.close();

      chat = await start({ contextWindow: '400000', resumeNativeSessionId: id });
      await vi.waitFor(() => expect(chat.limits()).toMatchObject({ effectiveTokens: 400000 }), { timeout: 20_000, interval: 100 });
      await chat.close();

      chat = await start({ resumeNativeSessionId: id });
      await vi.waitFor(() => expect(chat.limits()).toMatchObject({ effectiveTokens: 1_000_000 }), { timeout: 20_000, interval: 100 });
      await chat.close();
      // A flag only: nothing saved into the CLI's own settings.
      const settings = path.join(home, '.claude', 'settings.json');
      expect(fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : '').not.toContain('autoCompactWindow');
    }, 240_000);
  });

  it('Codex: sets the window at start and on a cold resume, and is not sticky', async () => {
    const { home, cwd } = setup();
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const toml = ['model_provider = "fake"', '[model_providers.fake]', 'name = "fake"', `base_url = "${model.url}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false', ''].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), toml);
    const env = { ...base(home), CODEX_HOME: codexHome, OPENAI_API_KEY: 'fake-key-for-a-local-server', CODEX_API_KEY: '' };
    const start = starter(new CodexChatDriver(), 'codex-cli', 'codex', cwd, env, { model: 'gpt-6-astra' });

    let chat = await start({ contextWindow: '500000' });
    await chat.turn();
    expect(chat.usageSize()).toBe(475_000);
    const id = chat.nativeId();
    await chat.close();

    chat = await start({ contextWindow: '300000', resumeNativeSessionId: id });
    await chat.turn();
    expect(chat.usageSize()).toBe(285_000);
    await chat.close();

    chat = await start({ resumeNativeSessionId: id });
    await chat.turn();
    expect(chat.usageSize()).toBe(258_400);
    await chat.close();
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toBe(toml);
  }, 240_000);

  const copilotEnv = (home: string) => ({
    ...base(home), COPILOT_HOME: path.join(home, '.copilot'), COPILOT_OFFLINE: 'true', COPILOT_PROVIDER_BASE_URL: `${model.url}/v1`, COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_API_KEY: 'fake-key-for-a-local-server', COPILOT_MODEL: 'gpt-fake-1', COPILOT_GITHUB_TOKEN: 'invalid', GH_TOKEN: 'invalid', GITHUB_TOKEN: 'invalid',
  });

  it('Copilot / SDK: reports the tier, keeps it across a resume, and goes back only when told', async () => {
    const { home, cwd } = setup();
    const start = starter(new CopilotSdkChatDriver(), 'copilot-cli', 'copilot', cwd, copilotEnv(home), {});
    const tier = (chat: Driven) => (chat.session as unknown as { sdk: { rpc: { model: { getCurrent(): Promise<{ contextTier?: string }> } } } }).sdk.rpc.model.getCurrent().then((c) => c.contextTier);

    let chat = await start({ contextWindow: 'long_context' });
    expect(await tier(chat)).toBe('long_context');
    await chat.turn();
    const id = chat.nativeId();
    await chat.close();

    chat = await start({ resumeNativeSessionId: id });
    expect(await tier(chat)).toBe('long_context');
    await chat.close();

    chat = await start({ contextWindow: 'default', resumeNativeSessionId: id });
    expect(await tier(chat)).toBe('default');
    await chat.close();
  }, 240_000);

  it('Copilot / ACP: starts and answers with the flag', async () => {
    const { home, cwd } = setup();
    const start = starter(createCopilotAcpChatDriver(), 'copilot-cli', 'copilot', cwd, copilotEnv(home), {});
    const chat = await start({ contextWindow: 'long_context' });
    await chat.turn();
    await chat.close();
  }, 120_000);
});
