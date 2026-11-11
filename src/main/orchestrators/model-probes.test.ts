import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseClaudeInitializeModels,
  parseCodexModelList,
  parseCopilotSdkModels,
  probeClaudeModels,
  probeCodexModels,
  probeCopilotModels,
  type CopilotSdkModel,
  type ModelProbeContext,
} from './model-probes';
import { chatFixturePath, writeFakeCliShims, type ChatFixtureCli } from './adapters/testing/fake-cli';
import type { Model } from './adapters/codex-protocol';
import { CodexAppServerClient } from './adapters/codex-app-server-client';

type Entry = { from: 'client' | 'cli'; msg: Record<string, any> };
/** A fixture's entries, without its header. */
function readEntries(file: string): Entry[] {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.from && e.msg) as Entry[];
}
type ProbeFixture = 'claude' | 'codex' | 'copilot-sdk';
const modelListFixture = (cli: ProbeFixture) => readEntries(chatFixturePath(cli, 'model-list'));

describe('parseClaudeInitializeModels (recorded initialize, Claude Code 2.1.312)', () => {
  const reply = modelListFixture('claude').find((e) => e.from === 'cli' && e.msg.type === 'control_response')!;
  const models = parseClaudeInitializeModels(reply.msg.response.response)!;

  it('lists every model the handshake returned, aliases first', () => {
    expect(models.map((m) => m.id).slice(0, 5)).toEqual(['default', 'opus', 'fable', 'sonnet', 'haiku']);
    expect(models.map((m) => m.id)).toContain('claude-opus-4-8');
  });

  it('marks the default and keeps labels, efforts and the resolved id', () => {
    expect(models[0]).toMatchObject({ id: 'default', label: 'Default (recommended)', isDefault: true, resolvedId: 'claude-opus-5-5' });
    expect(models.find((m) => m.id === 'opus')).toMatchObject({
      label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], resolvedId: 'claude-opus-5-5',
    });
    expect(models.filter((m) => m.isDefault)).toHaveLength(1);
  });

  it('omits efforts for a model without them, and a resolved id equal to the id', () => {
    const haiku45 = models.find((m) => m.id === 'claude-haiku-4-5-20251001')!;
    expect(haiku45.efforts).toBeUndefined();
    expect(haiku45.resolvedId).toBeUndefined();
  });

  it('returns null when the reply has no models', () => {
    expect(parseClaudeInitializeModels({ commands: [] })).toBeNull();
    expect(parseClaudeInitializeModels({ models: [{ displayName: 'no value' }] })).toBeNull();
  });
});

describe('parseCodexModelList (recorded model/list, codex-cli 0.163.0)', () => {
  const reply = modelListFixture('codex').find((e) => e.from === 'cli' && e.msg.id === 2)!;
  const data = reply.msg.result.data as Model[];
  const models = parseCodexModelList(data)!;

  it('puts Clubhouse\'s Default first, then Codex\'s catalog in order', () => {
    expect(models[0]).toEqual({ id: 'default', label: 'Default' });
    expect(models.slice(1).map((m) => m.id)).toEqual(data.map((m) => m.model));
  });

  it('marks Codex\'s own default and keeps efforts', () => {
    const def = models.find((m) => m.isDefault)!;
    expect(def.id).toBe('gpt-6.1-sol');
    expect(def.label).toBe('GPT-6.1-Sol');
    expect(def.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('keeps hidden models, marked', () => {
    const hidden = parseCodexModelList([{ ...data[0], model: 'internal', id: 'internal', hidden: true }])!;
    expect(hidden.find((m) => m.id === 'internal')?.hidden).toBe(true);
  });

  it('returns null for an empty catalog', () => {
    expect(parseCodexModelList([])).toBeNull();
  });
});

describe('parseCopilotSdkModels (models.list, hand-made from the SDK ModelInfo type)', () => {
  const reply = modelListFixture('copilot-sdk').find((e) => e.from === 'cli' && e.msg.id === 1 && e.msg.result)!;
  const data = reply.msg.result.models as CopilotSdkModel[];
  const models = parseCopilotSdkModels(data)!;

  it('lists each enabled model once, after Clubhouse\'s Default', () => {
    const ids = models.map((m) => m.id);
    expect(ids[0]).toBe('default');
    expect(ids).toContain('claude-sonnet-5.5');
    expect(ids).toContain('auto');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves out models the login\'s policy disables, and keeps ones that need enabling', () => {
    expect(models.some((m) => m.id === 'gpt-5.6-sol-fast')).toBe(false);
    expect(models.some((m) => m.id === 'gpt-6.1-sol')).toBe(true);
  });

  it('carries Copilot\'s cost multiplier as the cost hint, and the name as the label', () => {
    expect(models.find((m) => m.id === 'claude-haiku-4.5')).toMatchObject({ label: 'Claude Haiku 4.5', costHint: '0.33x' });
    expect(models.find((m) => m.id === 'claude-opus-5.5')?.costHint).toBe('15x');
  });

  it('keeps reasoning efforts where the model has them', () => {
    expect(models.find((m) => m.id === 'claude-sonnet-5.5')?.efforts).toEqual(['low', 'medium', 'high']);
    expect(models.find((m) => m.id === 'claude-opus-5.5')?.efforts).toBeUndefined();
  });

  it('does not claim a default model: Copilot does not say which it would pick', () => {
    expect(models.some((m) => m.isDefault)).toBe(false);
  });

  it('returns null when nothing usable is listed', () => {
    expect(parseCopilotSdkModels([])).toBeNull();
    expect(parseCopilotSdkModels([{ id: 'x', policy: { state: 'disabled' } }])).toBeNull();
  });
});

describe('live probes, replayed through the fake CLI (no real CLI, no prompt)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    dir = undefined;
  });

  async function fakeFor(cli: ChatFixtureCli): Promise<{ ctx: ModelProbeContext; report: () => Promise<Record<string, any>> }> {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'model-probe-'));
    const reportPath = path.join(dir, 'report.json');
    const shims = await writeFakeCliShims(path.join(dir, 'bin'), {
      [cli]: { fixture: chatFixturePath(cli === 'copilot' ? 'copilot-sdk' : cli, 'model-list'), report: reportPath },
    });
    return {
      ctx: { binary: shims[cli], cwd: dir, signal: new AbortController().signal, timeoutMs: 10_000 },
      report: async () => JSON.parse(await fs.promises.readFile(reportPath, 'utf8')),
    };
  }

  it('Claude: initialize only, then the process is killed', async () => {
    const { ctx, report } = await fakeFor('claude');
    const models = await probeClaudeModels(ctx);
    expect(models?.[0]).toMatchObject({ id: 'default', isDefault: true });
    const r = await report();
    expect(r.mismatch).toBeNull();
    expect(r.complete).toBe(true);
    expect(r.argv).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json']));
    expect(r.unexpected).toEqual([]);
  });

  it('Codex: initialize and model/list over app-server', async () => {
    const { ctx, report } = await fakeFor('codex');
    const models = await probeCodexModels(ctx);
    expect(models?.find((m) => m.isDefault)?.id).toBe('gpt-6.1-sol');
    const r = await report();
    expect(r.mismatch).toBeNull();
    expect(r.complete).toBe(true);
    expect(r.argv).toEqual(['app-server']);
  });

  it('Codex: refuses a partial catalog when the page limit leaves another cursor', async () => {
    vi.spyOn(CodexAppServerClient.prototype, 'start').mockResolvedValue({
      userAgent: 'test', codexHome: '/test', platformFamily: 'unix', platformOs: 'macos',
    });
    const request = vi.spyOn(CodexAppServerClient.prototype, 'requestRaw').mockResolvedValue({
      data: [{ id: 'listed', model: 'listed', displayName: 'Listed' }], nextCursor: 'another-page',
    });
    const kill = vi.spyOn(CodexAppServerClient.prototype, 'kill').mockImplementation(() => {});
    await expect(probeCodexModels({
      binary: 'unused', cwd: os.tmpdir(), signal: new AbortController().signal, timeoutMs: 1000,
    })).rejects.toThrow('page limit');
    expect(request).toHaveBeenCalledTimes(5);
    expect(kill).toHaveBeenCalledOnce();
  });

  it('Codex: refuses a missing model page instead of treating it as the end of the catalog', async () => {
    vi.spyOn(CodexAppServerClient.prototype, 'start').mockResolvedValue({
      userAgent: 'test', codexHome: '/test', platformFamily: 'unix', platformOs: 'macos',
    });
    vi.spyOn(CodexAppServerClient.prototype, 'requestRaw')
      .mockResolvedValueOnce({ data: [{ id: 'listed', model: 'listed' }], nextCursor: 'next' })
      .mockResolvedValueOnce({});
    vi.spyOn(CodexAppServerClient.prototype, 'kill').mockImplementation(() => {});
    await expect(probeCodexModels({
      binary: 'unused', cwd: os.tmpdir(), signal: new AbortController().signal, timeoutMs: 1000,
    })).rejects.toThrow('incomplete model catalog');
  });

  it('Copilot: connect and models.list over the SDK, never a session or a prompt', async () => {
    const { ctx, report } = await fakeFor('copilot');
    const models = await probeCopilotModels(ctx);
    expect(models?.[0]).toEqual({ id: 'default', label: 'Default' });
    expect(models?.find((m) => m.id === 'claude-haiku-4.5')?.costHint).toBe('0.33x');
    const r = await report();
    expect(r.mismatch).toBeNull();
    expect(r.complete).toBe(true);
    expect(r.unexpected).toEqual([]);
    expect(r.argv).toEqual(expect.arrayContaining(['--headless', '--port', '0']));
  });

  it('Copilot: an aborted probe never spawns the CLI', async () => {
    const { ctx } = await fakeFor('copilot');
    const controller = new AbortController();
    controller.abort();
    await expect(probeCopilotModels({ ...ctx, signal: controller.signal })).rejects.toThrow();
  });

  it('an aborted probe never spawns the CLI', async () => {
    const { ctx } = await fakeFor('codex');
    const controller = new AbortController();
    controller.abort();
    await expect(probeCodexModels({ ...ctx, signal: controller.signal })).rejects.toThrow();
  });
});
