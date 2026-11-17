import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoCopilotPackages, prepareNativeModules } from './package-native-modules';

const dirs: string[] = [];
function dir() { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-package-guard-')); dirs.push(value); return value; }
afterEach(() => { for (const value of dirs.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

describe('packaged Copilot exclusions', () => {
  it.each(['copilot-sdk-v3-fixture', '@microsoft/copilot-sdk', '@microsoft/copilot-sdk-darwin-arm64', '@github/copilot-sdk-linux-x64', 'koffi', '@koromix/koffi-win32-x64', 'other/node_modules/copilot-sdk-v3-fixture'])('rejects %s from packaged node_modules', (name) => {
    const build = dir();
    fs.mkdirSync(path.join(build, 'node_modules', name), { recursive: true });
    expect(() => assertNoCopilotPackages(build)).toThrow('forbidden Copilot SDK/runtime/FFI package');
  });

  it('stages the production native modules without copying SDKs or the test-only alias', () => {
    const project = dir();
    const build = dir();
    const modules = path.join(project, 'node_modules');
    fs.mkdirSync(path.join(modules, 'node-pty'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'node-pty/package.json'), JSON.stringify({ dependencies: { 'node-addon-api': '1.0.0' } }));
    for (const name of ['node-addon-api', 'copilot-sdk-v3-fixture', '@microsoft/copilot-sdk-darwin-arm64', 'koffi']) {
      fs.mkdirSync(path.join(modules, name), { recursive: true });
      fs.writeFileSync(path.join(modules, name, 'package.json'), '{}');
    }
    prepareNativeModules(project, build);
    expect(fs.readdirSync(path.join(build, 'node_modules')).sort()).toEqual(['node-addon-api', 'node-pty']);
    expect(() => assertNoCopilotPackages(build)).not.toThrow();
  });
});
