import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KIND_BUDGET,
  MAX_BREADCRUMBS,
  _resetBreadcrumbsForTests,
  codePart,
  recentBreadcrumbs,
  recordBreadcrumb,
  recordBreadcrumbFrom,
  recordRendererBreadcrumb,
} from './breadcrumbs';

let now = 0;

beforeEach(() => {
  now = 0;
  _resetBreadcrumbsForTests(() => now);
});

afterEach(() => _resetBreadcrumbsForTests());

describe('breadcrumbs', () => {
  it('returns the latest across kinds, newest first, with their epoch times', () => {
    now = 100; recordBreadcrumb('event', 'view.agent');
    now = 200; recordBreadcrumb('error', 'chat.start_failed.claude-sdk');
    now = 300; recordBreadcrumb('performance', 'ui.long_frame', 640.4);
    expect(recentBreadcrumbs()).toEqual([
      { kind: 'performance', atMs: 300, code: 'ui.long_frame', value: 640.4 },
      { kind: 'error', atMs: 200, code: 'chat.start_failed.claude-sdk' },
      { kind: 'event', atMs: 100, code: 'view.agent' },
    ]);
  });

  it('keeps each kind to its budget so view changes cannot push out errors, and caps the report at 40', () => {
    for (let i = 0; i < 5; i++) { now++; recordBreadcrumb('error', `pty.exit_error`, i); }
    for (let i = 0; i < 100; i++) { now++; recordBreadcrumb('event', i % 2 ? 'view.agent' : 'view.canvas'); }
    for (let i = 0; i < 100; i++) { now++; recordBreadcrumb('performance', 'ui.long_frame', i); }
    const recent = recentBreadcrumbs();
    expect(recent).toHaveLength(MAX_BREADCRUMBS);
    expect(recent.filter((b) => b.kind === 'error')).toHaveLength(5);
    expect(recent.filter((b) => b.kind === 'performance')).toHaveLength(KIND_BUDGET.performance);
    expect(recent.filter((b) => b.kind === 'event')).toHaveLength(MAX_BREADCRUMBS - 5 - KIND_BUDGET.performance);
    // Newest first.
    expect(recent.map((b) => b.atMs)).toEqual([...recent.map((b) => b.atMs)].sort((a, b) => b - a));
  });

  it('skips a repeated view change', () => {
    recordBreadcrumb('event', 'view.agent');
    recordBreadcrumb('event', 'view.agent');
    recordBreadcrumb('event', 'view.canvas');
    recordBreadcrumb('event', 'view.agent');
    expect(recentBreadcrumbs().map((b) => b.code)).toEqual(['view.agent', 'view.canvas', 'view.agent']);
  });

  it('refuses codes that could carry user text, and unknown kinds', () => {
    expect(recordBreadcrumb('event', 'Fix the login bug')).toBe(false);
    expect(recordBreadcrumb('event', '/Users/alice/project')).toBe(false);
    expect(recordBreadcrumb('event', '')).toBe(false);
    expect(recordBreadcrumb('event', 'x'.repeat(61))).toBe(false);
    expect(recordBreadcrumbFrom({ kind: 'info', code: 'view.agent' })).toBe(false);
    expect(recordBreadcrumbFrom('view.agent')).toBe(false);
    expect(recordBreadcrumbFrom({ kind: 'event', code: 'view.agent', value: 'nope' })).toBe(true);
    expect(recentBreadcrumbs()).toEqual([{ kind: 'event', atMs: 0, code: 'view.agent' }]);
  });

  it('turns a bounded id into a safe code part', () => {
    expect(codePart('Claude-Code')).toBe('claude-code');
    expect(codePart('copilot cli/1.0')).toBe('copilot_cli_1_0');
    expect(codePart('')).toBe('unknown');
  });

  it('returns copies', () => {
    recordBreadcrumb('event', 'view.agent');
    recentBreadcrumbs()[0].code = 'changed';
    expect(recentBreadcrumbs()[0].code).toBe('view.agent');
  });
});

describe('breadcrumbs from a renderer (#2303)', () => {
  it('takes view changes, runtime switches and long-frame bursts', () => {
    expect(recordRendererBreadcrumb({ kind: 'event', code: 'view.canvas' })).toBe(true);
    expect(recordRendererBreadcrumb({ kind: 'event', code: 'runtime.switch.chat' })).toBe(true);
    expect(recordRendererBreadcrumb({ kind: 'error', code: 'runtime.switch_failed.terminal' })).toBe(true);
    expect(recordRendererBreadcrumb({ kind: 'performance', code: 'ui.long_frame', value: 640 })).toBe(true);
    expect(recordRendererBreadcrumb({ kind: 'performance', code: 'ui.slow_interaction', value: 320 })).toBe(true);
    expect(recentBreadcrumbs()).toHaveLength(5);
  });

  it("refuses main's own codes, a mismatched kind and anything malformed", () => {
    for (const raw of [
      { kind: 'error', code: 'chat.start_failed.claude' },
      { kind: 'error', code: 'pty.exit_error' },
      { kind: 'performance', code: 'window.unresponsive', value: 9_000 },
      { kind: 'error', code: 'view.canvas' },
      { kind: 'event', code: 'ui.long_frame' },
      { kind: 'event', code: 'view.Has User Text' },
      { kind: 'event', code: 'view.' },
      { kind: 'event' },
      'view.canvas',
      null,
    ]) {
      expect(recordRendererBreadcrumb(raw)).toBe(false);
    }
    expect(recentBreadcrumbs()).toEqual([]);
  });
});

describe('breadcrumbs in a Framebriar report', () => {
  it('pass the SDK report validation unchanged and leave room for the longest notes', async () => {
    const { normalizeReport } = await import('../vendor/framebriar/src/protocol.mjs');
    let t = 1_792_300_000_000;
    _resetBreadcrumbsForTests(() => t++);
    const longest = (prefix: string) => `${prefix}${'x'.repeat(60 - prefix.length)}`;
    for (let i = 0; i < 20; i++) recordBreadcrumb('error', longest('chat.start_failed.'), 1);
    for (let i = 0; i < 20; i++) recordBreadcrumb('performance', longest('ui.long_frame.'), 12345.678);
    for (let i = 0; i < 30; i++) recordBreadcrumb('event', longest(`view.${i}.`));
    const breadcrumbs = recentBreadcrumbs();
    const report = normalizeReport({
      v: 1, id: '0b6f1c1e-6a3b-4c1d-9f2e-1a2b3c4d5e6f', gameId: 'clubhouse', buildSha: '71b4bc9d', scene: 'agents',
      sessionId: 's1', seed: null, platform: 'darwin', input: 'mixed', capturedAt: new Date().toISOString(),
      notes: 'n'.repeat(2000), breadcrumbs, media: null,
    });
    expect(report.breadcrumbs).toHaveLength(40);
    expect(report.breadcrumbs.map((b: { code: string }) => b.code)).toEqual(breadcrumbs.map((b) => b.code));
    expect(report.buildSha).toBe('71b4bc9d');
  });
});
