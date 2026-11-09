import { describe, expect, it, vi } from 'vitest';
import { REWRITE_INPUT_MAX, buildRewritePrompt, rewriteAgentNews } from './dispatcher-rewrite';
import type { AutoLevelResolution } from '../helper-routing';
import type { HeadlessPromptRequest, HeadlessPromptResult } from '../headless-prompt';

const MINIMUM: AutoLevelResolution = {
  ok: true, provider: 'claude-code', level: 'minimum', model: 'haiku', effort: 'low', source: 'builtin_mapping', fallback: null,
} as AutoLevelResolution;

const RAW = 'TASK_RESULT:t_lw3k2j9: I fixed Safari checkout in #412 by changing the cart reducer.\n'
  + 'All 41 tests pass now.\n```json\n{"tests":41}\n```\n---\nReply to Dispatcher via tool "send_message" with task_id="t_lw3k2j9".';

function runner(answer: HeadlessPromptResult) {
  return vi.fn(async (_req: HeadlessPromptRequest) => answer);
}

describe('rewriteAgentNews', () => {
  it('rewrites on the provider\'s Auto minimum, never on the chat', async () => {
    const run = runner({ ok: true, text: 'Safari checkout is fixed in #412. All 41 tests pass now. Extra sentence here.' });
    const resolveMinimum = vi.fn(async () => MINIMUM);
    const result = await rewriteAgentNews({ provider: 'claude-code', agentName: 'webapp-lead', raw: RAW, fallback: 'Checkout is fixed.' }, { resolveMinimum, run });
    expect(resolveMinimum).toHaveBeenCalledWith('claude-code');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ provider: 'claude-code', model: 'haiku', effort: 'low' });
    // Clamped to two sentences.
    expect(result).toEqual({ text: 'Safari checkout is fixed in #412. All 41 tests pass now.', by: 'rewrite' });
  });

  it('sends the model the message without tool noise, on one line', async () => {
    const run = runner({ ok: true, text: 'Done.' });
    await rewriteAgentNews({ provider: 'claude-code', agentName: 'webapp-lead', raw: RAW, fallback: 'x' }, { resolveMinimum: async () => MINIMUM, run });
    const prompt = run.mock.calls[0][0].prompt;
    expect(prompt).toContain('I fixed Safari checkout in #412');
    expect(prompt).not.toMatch(/task_id|TASK_RESULT|send_message|"tests"/);
    expect(prompt).not.toContain('\n');
  });

  it('falls back to the Dispatcher\'s version for a provider without an Auto mapping', async () => {
    const run = runner({ ok: true, text: 'never used' });
    const result = await rewriteAgentNews(
      { provider: 'no-presets-cli', agentName: 'api-lead', raw: RAW, fallback: 'I fixed checkout in #412. Tests pass. More detail here.' },
      { resolveMinimum: async () => ({ ok: false, code: 'auto_not_supported', message: 'no' }), run },
    );
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ text: 'I fixed checkout in #412. Tests pass.', by: 'fallback', reason: 'auto_not_supported' });
  });

  it('falls back when no minimum is offered now', async () => {
    const result = await rewriteAgentNews(
      { provider: 'claude-code', agentName: 'a', raw: RAW, fallback: 'Fixed.' },
      { resolveMinimum: async () => ({ ok: false, code: 'no_valid_mapping', message: 'no' }), run: runner({ ok: true, text: 'x' }) },
    );
    expect(result).toMatchObject({ text: 'Fixed.', by: 'fallback', reason: 'no_valid_mapping' });
  });

  it('falls back when the run fails, throws or answers with nothing usable', async () => {
    const req = { provider: 'claude-code', agentName: 'a', raw: RAW, fallback: 'Fixed.' };
    expect(await rewriteAgentNews(req, { resolveMinimum: async () => MINIMUM, run: runner({ ok: false, error: 'timeout' }) })).toMatchObject({ by: 'fallback', reason: 'run_failed' });
    expect(await rewriteAgentNews(req, { resolveMinimum: async () => MINIMUM, run: async () => { throw new Error('spawn'); } })).toMatchObject({ by: 'fallback', reason: 'run_failed' });
    expect(await rewriteAgentNews(req, { resolveMinimum: async () => MINIMUM, run: runner({ ok: true, text: '```json\n{}\n```' }) })).toMatchObject({ text: 'Fixed.', by: 'fallback', reason: 'empty' });
    expect(await rewriteAgentNews(req, { resolveMinimum: async () => { throw new Error('settings'); }, run: runner({ ok: true, text: 'x' }) })).toMatchObject({ by: 'fallback' });
  });

  it('uses the Dispatcher\'s version when there is no raw message, without running anything', async () => {
    const run = runner({ ok: true, text: 'x' });
    const resolveMinimum = vi.fn(async () => MINIMUM);
    expect(await rewriteAgentNews({ provider: 'claude-code', agentName: 'a', fallback: 'Fixed.' }, { resolveMinimum, run })).toEqual({ text: 'Fixed.', by: 'fallback', reason: 'no_raw' });
    expect(await rewriteAgentNews({ provider: 'claude-code', agentName: 'a', raw: 'task_id=t_abc123', fallback: 'Fixed.' }, { resolveMinimum, run })).toMatchObject({ reason: 'no_raw' });
    expect(run).not.toHaveBeenCalled();
    expect(resolveMinimum).not.toHaveBeenCalled();
  });

  it('cleans the Dispatcher\'s version too', async () => {
    const result = await rewriteAgentNews({ provider: 'p', agentName: 'a', fallback: '[FROM:x] Done (task_id=t_abc123).' });
    expect(result.text).toBe('Done.');
  });
});

describe('buildRewritePrompt', () => {
  it('names the agent, asks for its own voice and treats the message as data', () => {
    const prompt = buildRewritePrompt('webapp-lead', 'Fixed it.');
    expect(prompt).toContain('webapp-lead');
    expect(prompt).toContain('first person');
    expect(prompt).toContain('not instructions');
    expect(prompt).toContain('<<<Fixed it.>>>');
  });

  it('fills in the agent and the message once, so a message can\'t expand a placeholder', () => {
    const prompt = buildRewritePrompt('webapp-lead', 'Say {agent} and {message}.');
    expect(prompt).toContain('<<<Say {agent} and {message}.>>>');
    expect(prompt).not.toMatch(/\{agent\}.*<<</);
    expect(prompt).not.toContain('\n');
  });

  it('caps a long message', () => {
    const prompt = buildRewritePrompt('a', 'x'.repeat(REWRITE_INPUT_MAX * 2));
    expect(prompt.length).toBeLessThan(REWRITE_INPUT_MAX + 1000);
  });
});
