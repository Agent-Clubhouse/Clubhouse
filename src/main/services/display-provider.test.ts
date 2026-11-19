import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentConfigTarget } from './agent-config-reader';
const m = vi.hoisted(() => ({ providers: new Map<string, object>() }));
vi.mock('../orchestrators', () => ({ getProvider: (id: string) => m.providers.get(id) }));
vi.mock('./agent-registry', () => ({ DEFAULT_ORCHESTRATOR: 'claude-code' }));
import { captureDisplayProvider } from './display-provider';
let root: string, target: AgentConfigTarget;
const provider = (id: string) => ({ id, displayName: `Host ${id}`, conventions: { legacyInstructionsFile: 'AGENTS.md', configDir: '.selected', mcpConfigFile: '.mcp.json' }, getCapabilities: () => ({ permissions: true }) });
const legacy = (value: unknown) => fs.writeFileSync(path.join(root, '.clubhouse', 'settings.json'), JSON.stringify(value));
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-display-provider-'))); fs.mkdirSync(path.join(root, '.clubhouse'));
  target = { agent: { id: 'selected', name: 'Selected', color: '', createdAt: '' }, project: { id: 'p', name: 'Selected project', path: root } };
  m.providers.clear(); for (const id of ['claude-code', 'codex-cli', 'copilot-cli']) m.providers.set(id, provider(id));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('uses the admitted agent and project override before the legacy fallback without reading unrelated inventories', () => {
  legacy({ orchestrator: 'copilot-cli', PRIVATE: 'PRIVATE_PROJECT_SETTING' }); target.project.orchestrator = 'codex-cli'; target.agent.orchestrator = 'claude-code';
  let read = captureDisplayProvider(target); expect(read.selection).toMatchObject({ state: 'ok', value: 'claude-code' }); expect(read.receipt.current()).toBe(true);
  delete target.agent.orchestrator; read = captureDisplayProvider(target); expect(read.selection).toMatchObject({ state: 'ok', value: 'codex-cli' });
  delete target.project.orchestrator; read = captureDisplayProvider(target); expect(read.selection).toMatchObject({ state: 'ok', value: 'copilot-cli' });
  expect(JSON.stringify(read.selection)).not.toMatch(/PRIVATE|profiles|\.clubhouse|settings.json/);
});
it('keeps true missing defaults separate from corrupt, malformed and oversized legacy metadata without recovery', () => {
  expect(captureDisplayProvider(target).selection).toMatchObject({ state: 'ok', value: 'claude-code' });
  for (const text of ['{broken', '[]', '{"orchestrator":null}', JSON.stringify({ orchestrator: 'claude-code', padding: 'x'.repeat(300 * 1024) })]) {
    const file = path.join(root, '.clubhouse', 'settings.json'); fs.writeFileSync(file, text); const before = fs.readdirSync(path.dirname(file));
    expect.soft(captureDisplayProvider(target).selection.state).toBe('unavailable'); expect.soft(fs.readFileSync(file, 'utf8')).toBe(text); expect.soft(fs.readdirSync(path.dirname(file))).toEqual(before);
  }
});
it('does not replace an unsupported explicit agent choice with a static provider default', () => {
  target.agent.orchestrator = 'removed-cli'; const read = captureDisplayProvider(target);
  expect(read.selection).toMatchObject({ state: 'ok', value: 'removed-cli' }); expect(read.provider).toBeUndefined(); expect(read.receipt.current()).toBe(true);
});
it('preserves ordinary removed-project-provider fallback and invalidates if that provider becomes available', () => {
  target.project.orchestrator = 'removed-cli'; legacy({ orchestrator: 'codex-cli' }); const read = captureDisplayProvider(target);
  expect(read.selection).toMatchObject({ state: 'ok', value: 'codex-cli' }); expect(read.receipt.current()).toBe(true);
  m.providers.set('removed-cli', provider('removed-cli')); expect(read.receipt.current()).toBe(false);
});
it('binds selected legacy choice and registry identity through later assembly without invalidating unrelated metadata', () => {
  legacy({ orchestrator: 'codex-cli' }); const first = captureDisplayProvider(target); expect(first.receipt.current()).toBe(true);
  legacy({ orchestrator: 'codex-cli', PRIVATE_OTHER: 'PRIVATE_OTHER_VALUE' }); expect(first.receipt.current()).toBe(true);
  legacy({ orchestrator: 'claude-code' }); expect(first.receipt.current()).toBe(false);
  const second = captureDisplayProvider(target); m.providers.set('claude-code', provider('claude-code')); expect(second.receipt.current()).toBe(false);
});

it('does not reuse an admitted provider observation for another selected agent or project', () => {
  const snapshot = captureDisplayProvider(target); expect(snapshot.matchesTarget(structuredClone(target))).toBe(true);
  expect(snapshot.matchesTarget({ ...target, agent: { ...target.agent, id: 'unrelated' } })).toBe(false);
  expect(snapshot.matchesTarget({ ...target, project: { ...target.project, path: root + '-other' } })).toBe(false);
});

it('invalidates in-place selected provider label and capability changes', () => {
  const first = captureDisplayProvider(target), selected = m.providers.get('claude-code') as ReturnType<typeof provider>;
  expect(first.receipt.current()).toBe(true); selected.displayName = 'Updated label'; expect(first.receipt.current()).toBe(false);
  const second = captureDisplayProvider(target); selected.getCapabilities = () => ({ permissions: false }); expect(second.receipt.current()).toBe(false);
});
