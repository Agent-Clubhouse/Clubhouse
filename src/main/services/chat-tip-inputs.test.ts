import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('../../__mocks__/electron')>('../../__mocks__/electron');
  return { ...actual, app: { ...actual.app, getPath: () => fixture.home, isPackaged: false } };
});
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

afterEach(() => {
  fs.rmSync(fixture.home, { recursive: true, force: true });
  vi.resetModules();
});

it('keeps project read uncertainty after quarantine and accepts a complete backup', async () => {
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'tip-project-'));
  const base = path.join(fixture.home, '.clubhouse-dev');
  fs.mkdirSync(base);
  const projects = await import('./project-store');
  await projects.list();
  expect(projects.isChatTipProjectReadUncertain()).toBe(false);
  fs.writeFileSync(path.join(base, 'projects.json'), '{bad');
  await projects.list();
  expect(projects.isChatTipProjectReadUncertain()).toBe(true);
  await projects.list(); // quarantine left the primary missing
  expect(projects.isChatTipProjectReadUncertain()).toBe(true);
  vi.resetModules(); // another launch still has the quarantine evidence
  const restarted = await import('./project-store');
  await restarted.list();
  expect(restarted.isChatTipProjectReadUncertain()).toBe(true);
  fs.writeFileSync(path.join(base, 'projects.json'), '{bad');
  fs.writeFileSync(path.join(base, 'projects.json.bak'), JSON.stringify({ version: 1, projects: [] }));
  vi.resetModules();
  const recovered = await import('./project-store');
  await recovered.list();
  expect(recovered.isChatTipProjectReadUncertain()).toBe(false);
});

it('keeps agent read uncertainty through a cached empty result and accepts a complete backup', async () => {
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'tip-agent-'));
  const project = path.join(fixture.home, 'project');
  const dir = path.join(project, '.clubhouse');
  fs.mkdirSync(dir, { recursive: true });
  const agents = await import('./agent-config');
  fs.writeFileSync(path.join(dir, 'agents.json'), '{bad');
  await agents.listDurable(project);
  expect(agents.isChatTipAgentReadUncertain()).toBe(true);
  await agents.listDurable(project);
  expect(agents.isChatTipAgentReadUncertain()).toBe(true);
  agents.clearAgentConfigCache();
  fs.writeFileSync(path.join(dir, 'agents.json.bak'), '[]');
  await agents.listDurable(project);
  expect(agents.isChatTipAgentReadUncertain()).toBe(false);
  agents.clearAgentConfigCache();
}, 15000);

it('retains a runtime settings read failure until a new process', async () => {
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'tip-runtime-'));
  const file = path.join(fixture.home, 'chat-runtime-settings.json');
  fs.writeFileSync(file, '{bad');
  let runtime = await import('./chat-runtime-settings');
  runtime.getSettings();
  expect(runtime.isChatTipRuntimeReadUncertain()).toBe(true);
  fs.writeFileSync(file, '{}');
  runtime.getSettings();
  expect(runtime.isChatTipRuntimeReadUncertain()).toBe(true);
  await runtime.saveSettings({});
  expect(runtime.isChatTipRuntimeReadUncertain()).toBe(false);
  vi.resetModules();
  runtime = await import('./chat-runtime-settings');
  runtime.getSettings();
  expect(runtime.isChatTipRuntimeReadUncertain()).toBe(false);
});
