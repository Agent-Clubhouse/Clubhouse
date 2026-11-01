import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acpSessionModels,
  parseClaudeInitializeModels,
  parseCodexModelList,
  probeClaudeModels,
  probeCodexModels,
  probeCopilotModels,
  removeUnpromptedCopilotSession,
  type ModelProbeContext,
} from './model-probes';
import { dedupeCopilotConfigOptions, dedupeCopilotLegacyModels, copilotModelCostHint } from './adapters/copilot-acp';
import { chatFixturePath, writeFakeCliShims, type ChatFixtureCli } from './adapters/testing/fake-cli';
import type { Model } from './adapters/codex-protocol';

type Entry = { from: 'client' | 'cli'; msg: Record<string, any> };
/** A fixture's entries, without its header. */
function readEntries(file: string): Entry[] {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.from && e.msg) as Entry[];
}
const modelListFixture = (cli: ChatFixtureCli) => readEntries(chatFixturePath(cli, 'model-list'));

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

describe('acpSessionModels (recorded Copilot session/new, 1.0.103)', () => {
  const reply = modelListFixture('copilot').find((e) => e.from === 'cli' && e.msg.id === 2 && e.msg.result)!;
  // What AcpSession stores with the Copilot profile applied.
  const state = {
    configOptions: dedupeCopilotConfigOptions(reply.msg.result.configOptions ?? []),
    legacyModels: dedupeCopilotLegacyModels(reply.msg.result.models),
  };
  const models = acpSessionModels(state, copilotModelCostHint)!;

  it('lists each model once, after Clubhouse\'s Default', () => {
    const ids = models.map((m) => m.id);
    expect(ids[0]).toBe('default');
    expect(ids).toContain('claude-sonnet-5.5');
    expect(ids).toContain('auto');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries Copilot\'s cost multiplier as the cost hint', () => {
    expect(models.find((m) => m.id === 'claude-haiku-4.5')?.costHint).toBe('0.33x');
    expect(models.find((m) => m.id === 'claude-opus-5.5')?.costHint).toBe('15x');
  });

  it('does not claim a default model: session/new reports Copilot\'s built-in one', () => {
    expect(models.some((m) => m.isDefault)).toBe(false);
  });

  it('returns null for a session without models', () => {
    expect(acpSessionModels({ configOptions: [], legacyModels: null })).toBeNull();
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
      [cli]: { fixture: chatFixturePath(cli, 'model-list'), report: reportPath },
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

  it('Copilot: initialize, session/new and session/close, never a prompt; removes only its own session folder', async () => {
    const { ctx, report } = await fakeFor('copilot');
    const stateDir = path.join(dir!, 'copilot-home', 'session-state');
    const own = await unpromptedSession(stateDir, RECORDED_COPILOT_SESSION);
    const other = await unpromptedSession(stateDir, OTHER_SESSION);
    const models = await probeCopilotModels({ ...ctx, env: { COPILOT_HOME: path.join(dir!, 'copilot-home') } });
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(models?.find((m) => m.id === 'claude-haiku-4.5')?.costHint).toBe('0.33x');
    const r = await report();
    expect(r.mismatch).toBeNull();
    expect(r.complete).toBe(true);
    expect(r.unexpected).toEqual([]);
  });

  it('an aborted probe never spawns the CLI', async () => {
    const { ctx } = await fakeFor('codex');
    const controller = new AbortController();
    controller.abort();
    await expect(probeCodexModels({ ...ctx, signal: controller.signal })).rejects.toThrow();
  });
});

/** The session id in the recorded copilot/model-list.jsonl. */
const RECORDED_COPILOT_SESSION = 'f8c7c8a0-c507-4ff9-9b1a-4f0b4d795aa9';
const OTHER_SESSION = '11111111-2222-4333-8444-555555555555';

/** What Copilot 1.0.103 leaves for a session/new that was closed unprompted. */
async function unpromptedSession(stateDir: string, id: string, workspace = `id: ${id}\ncwd: /workspace/project\nsummary_count: 0\n`): Promise<string> {
  const dir = path.join(stateDir, id);
  await fs.promises.mkdir(path.join(dir, 'checkpoints'), { recursive: true });
  await fs.promises.mkdir(path.join(dir, 'files'), { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'workspace.yaml'), workspace);
  await fs.promises.writeFile(path.join(dir, '.workspace-fork.lock'), '');
  await fs.promises.writeFile(path.join(dir, 'checkpoints', 'index.md'), '');
  return dir;
}

describe('removeUnpromptedCopilotSession', () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'copilot-state-')), 'session-state');
  });
  afterEach(async () => {
    await fs.promises.rm(path.dirname(stateDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('removes only the folder for the probe\'s own session id', async () => {
    const own = await unpromptedSession(stateDir, RECORDED_COPILOT_SESSION);
    const other = await unpromptedSession(stateDir, OTHER_SESSION);
    expect(await removeUnpromptedCopilotSession(stateDir, RECORDED_COPILOT_SESSION)).toBe(true);
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(stateDir)).toBe(true);
  });

  it('keeps a folder that shows a prompt, and logs why at debug', async () => {
    const own = await unpromptedSession(stateDir, RECORDED_COPILOT_SESSION);
    await fs.promises.writeFile(path.join(own, 'events.jsonl'), '{"type":"user.message"}\n');
    const log = vi.fn();
    expect(await removeUnpromptedCopilotSession(stateDir, RECORDED_COPILOT_SESSION, log)).toBe(false);
    expect(fs.existsSync(path.join(own, 'events.jsonl'))).toBe(true);
    expect(log).toHaveBeenCalledWith('debug', expect.any(String), expect.objectContaining({ reason: 'holds events.jsonl' }));
  });

  it('keeps a folder with summaries, files or another session\'s workspace', async () => {
    const summarized = await unpromptedSession(stateDir, RECORDED_COPILOT_SESSION, `id: ${RECORDED_COPILOT_SESSION}\nsummary_count: 1\n`);
    expect(await removeUnpromptedCopilotSession(stateDir, RECORDED_COPILOT_SESSION)).toBe(false);
    expect(fs.existsSync(summarized)).toBe(true);

    const withFile = await unpromptedSession(stateDir, OTHER_SESSION);
    await fs.promises.writeFile(path.join(withFile, 'files', 'notes.md'), 'x');
    expect(await removeUnpromptedCopilotSession(stateDir, OTHER_SESSION)).toBe(false);
    expect(fs.existsSync(withFile)).toBe(true);

    const mismatched = await unpromptedSession(stateDir, 'abc-123', `id: ${OTHER_SESSION}\nsummary_count: 0\n`);
    expect(await removeUnpromptedCopilotSession(stateDir, 'abc-123')).toBe(false);
    expect(fs.existsSync(mismatched)).toBe(true);
  });

  it('never resolves outside the session-state dir', async () => {
    const other = await unpromptedSession(stateDir, OTHER_SESSION);
    for (const id of ['..', '.', '', `..${path.sep}session-state`, `x${path.sep}..${path.sep}${OTHER_SESSION}`, '*']) {
      expect(await removeUnpromptedCopilotSession(stateDir, id), id).toBe(false);
    }
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(stateDir)).toBe(true);
  });

  it('does nothing when the folder is missing', async () => {
    expect(await removeUnpromptedCopilotSession(stateDir, RECORDED_COPILOT_SESSION)).toBe(false);
  });
});
