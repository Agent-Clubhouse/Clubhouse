import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { REMOVED_PLUGIN_API_VERSIONS, SUPPORTED_PLUGIN_API_VERSIONS } from './marketplace-types';

// The docs name the supported plugin API versions; the code is the source of truth (#1675).
const root = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const fmt = (v: number) => v.toFixed(1);

function versionsAfter(text: string, label: string): string[] {
  const line = text.split(/\r?\n/).find((l) => l.includes(label));
  expect(line, `"${label}" line`).toBeDefined();
  const rest = line!.slice(line!.indexOf(label) + label.length);
  const listed = rest.split(/\.\s|\s\(/)[0];
  return [...listed.matchAll(/`(\d+\.\d+)`/g)].map((m) => m[1]);
}

describe('plugin API versions in the docs match the code', () => {
  const supported = SUPPORTED_PLUGIN_API_VERSIONS.map(fmt);

  it.each(['README.md', 'CONTRIBUTING.md'])('%s lists exactly the supported versions', (file) => {
    expect(versionsAfter(read(file), 'Current supported API versions:')).toEqual(supported);
  });

  it('docs/sdk-versioning.md marks each supported version supported and each removed one removed', () => {
    const doc = read('docs/sdk-versioning.md');
    for (const v of SUPPORTED_PLUGIN_API_VERSIONS) expect(doc).toMatch(new RegExp(`\\| v${fmt(v).replace('.', '\\.')} \\| stable \\|`));
    for (const v of REMOVED_PLUGIN_API_VERSIONS) expect(doc).toMatch(new RegExp(`\\| v${fmt(v).replace('.', '\\.')} \\| removed \\|`));
    expect(doc).not.toMatch(/\| v\d+\.\d+ \| wip \|/);
  });

  it.each(['plugins-creating.md', 'plugins-creating.chrome.md'])('help %s names the loadable versions', (file) => {
    const text = read(path.join('src/renderer/features/help/content', file));
    const loads = SUPPORTED_PLUGIN_API_VERSIONS.map(fmt);
    expect(text).toContain(`Clubhouse loads ${loads.slice(0, -1).join(', ')} and ${loads[loads.length - 1]}`);
    expect(text).toContain(`current: **${loads[loads.length - 1]}**`);
  });
});
