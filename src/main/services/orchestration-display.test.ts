import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type { AgentConfigTarget } from './agent-config-reader';
import { readOrchestrationForDisplay, readProjectHelperAutoOffForDisplay } from './orchestration-display';
import { resetAllSettingsStoresForTests } from './settings-store';
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
let root: string, target: AgentConfigTarget;
const project = (raw: unknown) => fs.writeFileSync(path.join(root, '.clubhouse', 'settings.json'), JSON.stringify(raw));
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-orchestration-display-policy-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); fs.mkdirSync(path.join(root, '.clubhouse'));
  target = { agent: { id: 'selected', name: 'Selected', color: '', createdAt: '' }, project: { id: 'p', name: 'Project', path: root } };
});
afterEach(() => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('resolves only admitted policy fields with defaults, helper semantics, and explicit false preserved', () => {
  target.agent.orchestration = { orchestrate: true, autoHelpers: true, maxHelpers: 8, connectToDispatcher: false };
  let result = readOrchestrationForDisplay(target);
  expect(result.fields.orchestrate).toMatchObject({ state: 'ok', value: true }); expect(result.fields.connectToDispatcher).toMatchObject({ state: 'ok', value: false }); expect(result.fields.control).toMatchObject({ state: 'ok', value: 'hands-off' }); expect(result.sources).toMatchObject({ orchestrate: 'agent', control: 'default' });
  target.agent.parentAgentId = 'parent'; target.agent.orchestration.connectToDispatcher = true;
  result = readOrchestrationForDisplay(target); expect(result.fields.connectToDispatcher).toMatchObject({ state: 'ok', value: false }); expect(result.sources.connectToDispatcher).toBe('default');
});
it('keeps invalid selected fields unknown without dropping independent valid information or inventing an origin', () => {
  target.agent.orchestration = { orchestrate: 'wrong', maxHelpers: 0, control: 'ask-everything', access: 'same' } as never;
  const result = readOrchestrationForDisplay(target);
  expect(result.fields.orchestrate.state).toBe('unavailable'); expect(result.fields.maxHelpers.state).toBe('unavailable'); expect(result.fields.connectToDispatcher.state).toBe('unavailable');
  expect(result.fields.control).toMatchObject({ state: 'ok', value: 'ask-everything' }); expect(result.fields.access).toMatchObject({ state: 'ok', value: 'same' }); expect(result.sources.orchestrate).toBeUndefined();
});
it.each([null, [], false])('does not normalize malformed policy %s into a verified off/default state', (bad) => {
  target.agent.orchestration = bad as never; const result = readOrchestrationForDisplay(target);
  expect(result.fields.orchestrate.state).toBe('unavailable'); expect(result.fields.control.state).toBe('unavailable');
});
it('distinguishes true missing project defaults from backup-only/corrupt or malformed relevant fields', () => {
  expect(readProjectHelperAutoOffForDisplay(root)).toMatchObject({ state: 'ok', value: false });
  const file = path.join(root, '.clubhouse', 'settings.json'); fs.writeFileSync(file + '.bak', '{"agentDefaults":{"helperAuto":"off"}}');
  expect(readProjectHelperAutoOffForDisplay(root).state).toBe('unavailable');
  for (const raw of [null, [], { agentDefaults: null }, { agentDefaults: { helperAuto: false } }]) { project(raw); expect.soft(readProjectHelperAutoOffForDisplay(root).state).toBe('unavailable'); }
  fs.writeFileSync(file, '{broken'); expect(readProjectHelperAutoOffForDisplay(root).state).toBe('unavailable');
  expect(fs.readFileSync(file + '.bak', 'utf8')).toBe('{"agentDefaults":{"helperAuto":"off"}}'); expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['settings.json', 'settings.json.bak']);
  expect(readProjectHelperAutoOffForDisplay(path.join(root, 'missing-root')).state).toBe('unavailable');
});
it('retains real selected project receipts through later relevant changes, ignoring unrelated defaults', () => {
  project({ agentDefaults: { helperAuto: 'off', PRIVATE: 'PRIVATE_OTHER' } }); const receipts: Array<{ current(): boolean }> = [];
  const result = readProjectHelperAutoOffForDisplay(root, { receipts }); expect(result).toMatchObject({ state: 'ok', value: true }); expect(receipts[0].current()).toBe(true); expect(JSON.stringify(result)).not.toMatch(/PRIVATE|agentDefaults/);
  project({ agentDefaults: { helperAuto: 'off', PRIVATE: 'CHANGED_PRIVATE' } }); expect(receipts[0].current()).toBe(true);
  project({ agentDefaults: {} }); expect(receipts[0].current()).toBe(false);
});
it('never guesses an unreadable app Auto flag, while retaining a known higher-priority project restriction', () => {
  target.agent.orchestration = { orchestrate: true }; fs.writeFileSync(path.join(root, 'orchestration-settings.json'), '{broken');
  expect(readOrchestrationForDisplay(target).autoEffective.state).toBe('unavailable');
  project({ agentDefaults: { helperAuto: 'off' } });
  expect(readOrchestrationForDisplay(target).autoEffective).toMatchObject({ state: 'ok', value: { effective: false, reason: 'project_off', source: 'project' } });
  project({}); target.agent.orchestration.autoHelpers = true;
  expect(readOrchestrationForDisplay(target).autoEffective).toMatchObject({ state: 'ok', value: { effective: true, source: 'agent' } });
});
