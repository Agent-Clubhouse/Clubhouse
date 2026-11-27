import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let userData = '';
vi.mock('electron', () => ({
  app: { getPath: () => userData },
}));

import { resetAllSettingsStoresForTests } from './settings-store';
import { _resetEarlierRunForTesting, EARLIER_RUN_MARKERS, getWelcomeTourState, noteEarlierRun } from './welcome-tour-state';

describe('welcome-tour-state: an earlier run (#2814)', () => {
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-tour-state-'));
    resetAllSettingsStoresForTests();
    _resetEarlierRunForTesting();
  });

  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('a fresh profile, even one seeded with settings, is no earlier run', () => {
    fs.writeFileSync(path.join(userData, 'experimental-settings.json'), '{}');
    fs.writeFileSync(path.join(userData, 'welcome-tour.json'), '{}');
    noteEarlierRun(userData);
    expect(getWelcomeTourState().earlierRun).toBe(false);
  });

  it.each(EARLIER_RUN_MARKERS)('%s left by an earlier run counts', (marker) => {
    if (marker.includes('.')) fs.writeFileSync(path.join(userData, marker), '{}');
    else fs.mkdirSync(path.join(userData, marker));
    noteEarlierRun(userData);
    expect(getWelcomeTourState().earlierRun).toBe(true);
  });

  it('is noted once, so files this launch writes later don’t change it', () => {
    noteEarlierRun(userData);
    fs.mkdirSync(path.join(userData, 'Local Storage'));
    noteEarlierRun(userData);
    expect(getWelcomeTourState().earlierRun).toBe(false);
  });

  it('reads and deletes nothing', () => {
    const file = path.join(userData, 'free-agent-settings.json');
    fs.writeFileSync(file, '{"saved":true}');
    const before = fs.statSync(file);
    noteEarlierRun(userData);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.statSync(file).size).toBe(before.size);
  });

  it('is left out until noted', () => {
    expect('earlierRun' in getWelcomeTourState()).toBe(false);
  });
});
