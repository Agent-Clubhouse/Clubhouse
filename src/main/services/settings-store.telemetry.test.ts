import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dir = vi.hoisted(() => ({ value: '' }));
vi.mock('electron', () => ({ app: { getPath: () => dir.value } }));
const persist = vi.hoisted(() => ({
  timed: vi.fn(async (_store: string, fn: () => Promise<unknown>) => fn()),
  recovery: vi.fn(),
}));
vi.mock('../telemetry/persist', () => ({ persist }));

import { createSettingsStore } from './settings-store';

beforeEach(() => {
  dir.value = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-settings-tel-'));
  persist.timed.mockClear();
  persist.recovery.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(dir.value, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('settings store telemetry', () => {
  it('times every write as a settings write', async () => {
    const store = createSettingsStore('tel-a.json', { n: 1 });
    await store.save({ n: 2 });
    expect(persist.timed).toHaveBeenCalledWith('settings', expect.any(Function));
    expect(JSON.parse(fs.readFileSync(path.join(dir.value, 'tel-a.json'), 'utf-8'))).toEqual({ n: 2 });
  });

  it('reports a corrupt file silently reset to defaults', () => {
    fs.writeFileSync(path.join(dir.value, 'tel-b.json'), '{not json');
    const store = createSettingsStore('tel-b.json', { n: 1 });
    expect(store.get()).toEqual({ n: 1 });
    expect(persist.recovery).toHaveBeenCalledWith('settings', 'reset_to_default');
  });

  it('does not report a missing file', () => {
    createSettingsStore('tel-c.json', { n: 1 }).get();
    expect(persist.recovery).not.toHaveBeenCalled();
  });
});
