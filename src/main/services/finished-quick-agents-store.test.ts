import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { userData } = vi.hoisted(() => ({ userData: { dir: '' } }));
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { resetAllSettingsStoresForTests } from './settings-store';
import {
  applyFinishedQuickAgentChange,
  flushFinishedQuickAgentsForTests,
  getFinishedQuickAgents,
  hydrateFinishedQuickAgents,
  isFinishedQuickAgentsReady,
  onFinishedQuickAgentsChange,
  resetFinishedQuickAgentsForTests,
} from './finished-quick-agents-store';
import type { CompletedQuickAgent } from '../../shared/types';

const rec = (id: string, projectId = 'p'): CompletedQuickAgent => ({
  id, projectId, name: `n-${id}`, mission: 'm', summary: 's', filesModified: [], exitCode: 0, completedAt: 1,
});
const file = () => path.join(userData.dir, 'finished-quick-agents.json');
/** Writes are queued after the in-memory change; wait for the file. */
async function stored(): Promise<Record<string, unknown>> {
  await flushFinishedQuickAgentsForTests();
  return JSON.parse(fs.readFileSync(file(), 'utf-8'));
}
/** A restart: the in-memory cache goes, the file stays. */
function restart(): void {
  resetAllSettingsStoresForTests();
  resetFinishedQuickAgentsForTests();
}

describe('finished-quick-agents-store (#2467)', () => {
  beforeEach(() => {
    userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-quick-'));
    restart();
  });
  afterEach(async () => {
    await flushFinishedQuickAgentsForTests();
    fs.rmSync(userData.dir, { recursive: true, force: true });
  });

  it('is not ready until a window hands over its localStorage lists', () => {
    expect(isFinishedQuickAgentsReady()).toBe(false);
    expect(getFinishedQuickAgents()).toEqual({});
  });

  it('migrates the first window\'s lists once, to disk, and ignores later hand-overs', async () => {
    const legacy = { p: [rec('b'), rec('a')], q: [rec('c', 'q')] };
    const listener = vi.fn();
    onFinishedQuickAgentsChange(listener);
    expect(hydrateFinishedQuickAgents(legacy)).toEqual(legacy);
    expect(isFinishedQuickAgentsReady()).toBe(true);
    expect(listener).toHaveBeenCalledWith({ state: legacy, acked: {} });
    expect(await stored()).toMatchObject({ version: 1, migrated: true, projects: legacy });

    // A second window, or the next launch, gets the stored lists back.
    restart();
    expect(isFinishedQuickAgentsReady()).toBe(true);
    expect(hydrateFinishedQuickAgents({ p: [rec('other')] })).toEqual(legacy);
  });

  it('migrates a window with nothing saved to empty lists, and sanitizes what it hands over', () => {
    expect(hydrateFinishedQuickAgents({ p: [rec('ok'), { id: 'broken' }], q: 'x' })).toEqual({ p: [rec('ok')] });
    expect(isFinishedQuickAgentsReady()).toBe(true);
  });

  it('applies ops in order, broadcasts each change, and acknowledges window ops even when they change nothing', async () => {
    hydrateFinishedQuickAgents({});
    const listener = vi.fn();
    onFinishedQuickAgentsChange(listener);

    expect(applyFinishedQuickAgentChange({ type: 'add', record: rec('a') }, { clientId: 'w1', seq: 1 })).toBe(true);
    expect(applyFinishedQuickAgentChange({ type: 'add', record: rec('b') }, { clientId: 'w1', seq: 2 })).toBe(true);
    expect(listener).toHaveBeenLastCalledWith({ state: { p: [rec('b'), rec('a')] }, acked: { w1: 2 } });

    // Already listed: no change, but the window hears its op was handled.
    expect(applyFinishedQuickAgentChange({ type: 'add', record: rec('a') }, { clientId: 'w1', seq: 3 })).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ acked: { w1: 3 } }));

    // A phone's dismissal changes it; a phone's no-op is silent.
    expect(applyFinishedQuickAgentChange({ type: 'dismiss', projectId: 'p', agentId: 'b' })).toBe(true);
    listener.mockClear();
    expect(applyFinishedQuickAgentChange({ type: 'dismiss', projectId: 'p', agentId: 'b' })).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    expect(await stored()).toMatchObject({ projects: { p: [rec('a')] } });
    restart();
    expect(getFinishedQuickAgents()).toEqual({ p: [rec('a')] });

    applyFinishedQuickAgentChange({ type: 'clear', projectId: 'p' });
    expect(getFinishedQuickAgents()).toEqual({ p: [] });
  });

  it('hands out copies, so a caller can\'t change the stored lists', () => {
    hydrateFinishedQuickAgents({ p: [rec('a')] });
    getFinishedQuickAgents().p.push(rec('z'));
    expect(getFinishedQuickAgents().p).toEqual([rec('a')]);
  });
});
