import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { userData } = vi.hoisted(() => ({ userData: { dir: '' } }));
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { resetAllSettingsStoresForTests } from './settings-store';
import {
  applyProjectStateChange,
  getProjectState,
  hydrateProjectState,
  isProjectStateReady,
  onProjectStateChange,
  resetProjectStateForTests,
} from './project-state-store';
import { DEFAULT_PROJECT_STATE } from '../../shared/project-state';

const file = () => path.join(userData.dir, 'project-state.json');
/** Writes are queued after the in-memory change; wait for the file. */
async function stored(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(fs.existsSync(file())).toBe(true));
  await new Promise((r) => setTimeout(r, 20));
  return JSON.parse(fs.readFileSync(file(), 'utf-8'));
}
/** A restart: the in-memory cache goes, the file stays. */
function restart(): void {
  resetAllSettingsStoresForTests();
  resetProjectStateForTests();
}

describe('project-state-store (#2458)', () => {
  beforeEach(() => {
    userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-'));
    restart();
  });
  afterEach(() => {
    fs.rmSync(userData.dir, { recursive: true, force: true });
  });

  it('is not ready until a window hands over its localStorage state', () => {
    expect(isProjectStateReady()).toBe(false);
    expect(getProjectState()).toEqual(DEFAULT_PROJECT_STATE);
  });

  it('migrates the first window\'s state once, to disk, and ignores later hand-overs', async () => {
    const legacy = { pinnedProjectIds: ['p1'], inactiveProjectIds: ['p2'], projectActivity: { p1: 10, p2: 20 }, idleDays: 14 };
    const listener = vi.fn();
    onProjectStateChange(listener);
    expect(hydrateProjectState(legacy)).toEqual(legacy);
    expect(isProjectStateReady()).toBe(true);
    expect(listener).toHaveBeenCalledWith({ state: legacy, acked: {} });
    expect(await stored()).toMatchObject({ version: 1, migrated: true, ...legacy });

    // A second window, or the next launch, gets the stored state back.
    restart();
    expect(isProjectStateReady()).toBe(true);
    expect(hydrateProjectState({ ...DEFAULT_PROJECT_STATE, pinnedProjectIds: ['other'] })).toEqual(legacy);
  });

  it('migrates a window with nothing saved to the defaults, and sanitizes what it hands over', () => {
    expect(hydrateProjectState({ pinnedProjectIds: [1, 'p'], idleDays: 'x' })).toEqual({ ...DEFAULT_PROJECT_STATE, pinnedProjectIds: ['p'] });
    expect(isProjectStateReady()).toBe(true);
  });

  it('applies ops in order, broadcasts each change, and acknowledges window ops even when they change nothing', async () => {
    hydrateProjectState(DEFAULT_PROJECT_STATE);
    const listener = vi.fn();
    onProjectStateChange(listener);

    expect(applyProjectStateChange({ type: 'setPinned', projectId: 'p', pinned: true }, { clientId: 'w1', seq: 1 })).toBe(true);
    expect(listener).toHaveBeenLastCalledWith({ state: { ...DEFAULT_PROJECT_STATE, pinnedProjectIds: ['p'] }, acked: { w1: 1 } });

    // Pinned, so it can't be marked inactive: no change, but the window hears its op was handled.
    expect(applyProjectStateChange({ type: 'setInactive', projectId: 'p', inactive: true, at: 1 }, { clientId: 'w1', seq: 2 })).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ acked: { w1: 2 } }));

    // A phone's no-op is silent.
    listener.mockClear();
    expect(applyProjectStateChange({ type: 'setPinned', projectId: 'p', pinned: true })).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    expect(await stored()).toMatchObject({ pinnedProjectIds: ['p'] });
    restart();
    expect(getProjectState().pinnedProjectIds).toEqual(['p']);
  });
});
