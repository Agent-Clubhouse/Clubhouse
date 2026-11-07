import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dir = vi.hoisted(() => ({ value: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => dir.value } }));

import { resetAllSettingsStoresForTests } from './settings-store';
import { effectiveAppSourceControlProvider } from './source-control-settings';

function write(filename: string, value: unknown): void {
  fs.writeFileSync(path.join(dir.value, filename), JSON.stringify(value));
}

beforeEach(() => {
  dir.value = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-settings-'));
  resetAllSettingsStoresForTests();
});

describe('effectiveAppSourceControlProvider (D61)', () => {
  it('is GitHub when nothing is set', () => {
    expect(effectiveAppSourceControlProvider()).toBe('github');
  });

  it('shows the old Clubhouse Mode value while its own setting is empty', () => {
    write('clubhouse-mode-settings.json', { enabled: false, sourceControlProvider: 'azure-devops' });
    expect(effectiveAppSourceControlProvider()).toBe('azure-devops');
  });

  it('reads its own setting before the old Clubhouse Mode one', () => {
    write('clubhouse-mode-settings.json', { enabled: false, sourceControlProvider: 'azure-devops' });
    write('source-control-settings.json', { provider: 'github' });
    expect(effectiveAppSourceControlProvider()).toBe('github');
  });
});
