import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Two real temp projects (#2511): the index reads every registered project's
// agents.json and follows parentProjectPath across them.

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-settings-service', () => ({
  applyAgentDefaults: vi.fn(async () => undefined),
  readProjectAgentDefaults: vi.fn(async () => ({})),
}));
vi.mock('./agent-system', () => ({ resolveOrchestrator: vi.fn() }));
vi.mock('./chat-idle-settings', () => ({ setAgentIdleSleep: vi.fn() }));
const registered: string[] = [];
vi.mock('./project-store', () => ({
  list: vi.fn(async () => registered.map((p, i) => ({ id: `proj_${i}`, name: path.basename(p), path: p }))),
}));

import { clearAgentConfigCache, flushAllAgentConfigs, listDurable, projectKey, setParentAgent } from './agent-config';
import { clearHelperIndexCache, findParent, listHelpersEverywhere } from './helper-index';
import type { DurableAgentConfig } from '../../shared/types';

let root: string;
let home: string;
let other: string;

function agent(id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name: id, color: 'blue', createdAt: '2026-10-31T00:00:00.000Z', ...extra };
}

function seed(projectPath: string, agents: DurableAgentConfig[]): void {
  fs.mkdirSync(path.join(projectPath, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, '.clubhouse', 'agents.json'), JSON.stringify(agents, null, 2));
}

function readDisk(projectPath: string): DurableAgentConfig[] {
  return JSON.parse(fs.readFileSync(path.join(projectPath, '.clubhouse', 'agents.json'), 'utf-8')) as DurableAgentConfig[];
}

const ids = (entries: Array<{ config: DurableAgentConfig }>) => entries.map((e) => e.config.id);

beforeEach(() => {
  clearAgentConfigCache();
  clearHelperIndexCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-helper-index-'));
  home = path.join(root, 'home');
  other = path.join(root, 'other');
  fs.mkdirSync(home);
  fs.mkdirSync(other);
  registered.splice(0, registered.length, home, other);
  seed(home, [
    agent('durable_1_orch'),
    agent('durable_2_local', { parentAgentId: 'durable_1_orch' }),
    agent('durable_3_gone', { parentAgentId: 'durable_1_orch', disposedAt: '2026-10-31T01:00:00.000Z' }),
  ]);
  seed(other, [
    agent('durable_4_far', { parentAgentId: 'durable_1_orch', parentProjectPath: home }),
    agent('durable_5_nested', { parentAgentId: 'durable_4_far' }),
    agent('durable_6_own'),
    agent('durable_7_own_helper', { parentAgentId: 'durable_6_own' }),
  ]);
});

afterEach(async () => {
  await flushAllAgentConfigs();
  clearAgentConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

// On this machine's real filesystem, so Windows CI checks real NTFS IDs and paths (#2628).
describe('projectKey', () => {
  it('reads the folder\'s exact file ID', async () => {
    const { dev, ino } = fs.statSync(home, { bigint: true });
    expect(await projectKey(home)).toBe(`ino:${dev}:${ino}`);
    expect(await projectKey(other)).not.toBe(await projectKey(home));
  });

  it('is the same for every spelling of a folder, short and long names included', async () => {
    const key = await projectKey(home);
    expect(await projectKey(path.join(other, '..', 'home'))).toBe(key);
    expect(await projectKey(fs.realpathSync.native(home))).toBe(key);
  });

  it('falls back to the resolved path for a folder that is gone', async () => {
    const missing = path.join(root, 'Missing');
    expect(await projectKey(missing)).toBe(process.platform === 'win32' ? `path:${missing.toLowerCase()}` : `path:${missing}`);
    expect(await projectKey(path.join(root, 'also-missing'))).not.toBe(await projectKey(missing));
  });

  it.runIf(process.platform === 'win32')('folds case in a fallback path on Windows', async () => {
    expect(await projectKey(path.join(root, 'MISSING'))).toBe(await projectKey(path.join(root, 'missing')));
  });
});

describe('listHelpersEverywhere', () => {
  it('lists direct helpers in every project, home project first, each with its project', async () => {
    const helpers = await listHelpersEverywhere(home, 'durable_1_orch');
    expect(helpers.map((e) => [e.projectPath, e.config.id])).toEqual([
      [home, 'durable_2_local'],
      [other, 'durable_4_far'],
    ]);
    expect(ids(await listHelpersEverywhere(home, 'durable_1_orch', { includeDisposed: true })))
      .toEqual(['durable_2_local', 'durable_3_gone', 'durable_4_far']);
  });

  it('lists helpers of helpers with recursive, nearest first, live only', async () => {
    expect(ids(await listHelpersEverywhere(home, 'durable_1_orch', { recursive: true })))
      .toEqual(['durable_2_local', 'durable_4_far', 'durable_5_nested']);
    // A helper's own helpers, seen from its project.
    expect(ids(await listHelpersEverywhere(other, 'durable_4_far'))).toEqual(['durable_5_nested']);
    expect(ids(await listHelpersEverywhere(other, 'durable_6_own'))).toEqual(['durable_7_own_helper']);
  });

  it('matches the parent project by identity, not spelling', async () => {
    seed(other, [agent('durable_4_far', { parentAgentId: 'durable_1_orch', parentProjectPath: path.join(home, '..', 'home') })]);
    clearAgentConfigCache();
    expect(ids(await listHelpersEverywhere(home, 'durable_1_orch'))).toEqual(['durable_2_local', 'durable_4_far']);
  });

  it('reads a home project the store does not list', async () => {
    registered.splice(0, registered.length, other);
    expect(ids(await listHelpersEverywhere(home, 'durable_1_orch'))).toEqual(['durable_2_local', 'durable_4_far']);
  });

  it('leaves out projects no longer registered, and skips a registered folder that is gone', async () => {
    expect(ids(await listHelpersEverywhere(home, 'durable_1_orch'))).toContain('durable_4_far');
    registered.splice(1);
    expect(ids(await listHelpersEverywhere(home, 'durable_1_orch'))).toEqual(['durable_2_local']);
    registered.push(path.join(root, 'missing'));
    expect(ids(await listHelpersEverywhere(home, 'durable_1_orch'))).toEqual(['durable_2_local']);
    expect(fs.existsSync(path.join(root, 'missing'))).toBe(false);
  });

  it('sees a change made through agent-config without a manual clear', async () => {
    expect(ids(await listHelpersEverywhere(home, 'durable_1_orch'))).toContain('durable_4_far');
    await setParentAgent(other, 'durable_4_far', null);
    expect(ids(await listHelpersEverywhere(home, 'durable_1_orch'))).toEqual(['durable_2_local']);
  });
});

describe('findParent', () => {
  it('finds a parent in another project through parentProjectPath', async () => {
    const [far] = (await listDurable(other)).filter((a) => a.id === 'durable_4_far');
    expect(await findParent(other, far)).toMatchObject({ projectPath: home, config: { id: 'durable_1_orch' } });
  });

  it('finds a same-project parent, and null for a top-level agent', async () => {
    const agents = await listDurable(other);
    expect(await findParent(other, agents.find((a) => a.id === 'durable_5_nested')!))
      .toMatchObject({ projectPath: other, config: { id: 'durable_4_far' } });
    expect(await findParent(other, agents.find((a) => a.id === 'durable_6_own')!)).toBeNull();
  });

  it('returns null, and unparents nothing, when the parent project was removed', async () => {
    fs.rmSync(home, { recursive: true, force: true });
    registered.splice(0, registered.length, other);
    clearAgentConfigCache();

    const far = (await listDurable(other)).find((a) => a.id === 'durable_4_far')!;
    expect(far).toMatchObject({ parentAgentId: 'durable_1_orch', parentProjectPath: home });
    expect(await findParent(other, far)).toBeNull();
    await flushAllAgentConfigs();
    expect(readDisk(other).find((a) => a.id === 'durable_4_far')).toMatchObject({ parentAgentId: 'durable_1_orch', parentProjectPath: home });
    expect(fs.existsSync(home)).toBe(false);
  });
});
