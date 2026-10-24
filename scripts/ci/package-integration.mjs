// Hosted-only test artifact packaging. Never signs, notarizes, publishes or launches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run only on a hosted Actions checkout');
assert.equal(process.platform, 'darwin', 'This artifact is for macOS');
assert.equal(path.resolve(process.env.GITHUB_WORKSPACE || ''), root);
const runId = process.env.GITHUB_RUN_ID;
const attempt = process.env.GITHUB_RUN_ATTEMPT;
assert.match(runId || '', /^\d+$/);
assert.match(attempt || '', /^\d+$/);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.match(sourceCommit, /^[a-f0-9]{40}$/);
const version = `0.0.0-integration.${runId}.${attempt}`;
const name = 'Clubhouse Integration';
const bundleId = 'com.mason-allen.clubhouse.integration';
const jiti = createJiti(import.meta.url);
const { default: base, assertHardenedFuseWire } = await jiti.import(path.join(root, 'forge.config.ts'));
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { getCurrentFuseWire } = require('@electron/fuses');
const config = {
  ...base,
  packagerConfig: {
    ...base.packagerConfig, name, appBundleId: bundleId, appVersion: version,
    extendInfo: { ...base.packagerConfig.extendInfo, CFBundleDisplayName: name, CFBundleURLTypes: [] },
    osxSign: false, osxNotarize: undefined,
  },
  plugins: base.plugins.map(plugin => plugin instanceof FusesPlugin
    ? new FusesPlugin({ ...plugin.fusesConfig, resetAdHocDarwinSignature: false }) : plugin),
  makers: [], publishers: [],
};
const assertUnsigned = resolved => {
  assert.equal(resolved.packagerConfig.name, name);
  assert.equal(resolved.packagerConfig.appBundleId, bundleId);
  assert.equal(resolved.packagerConfig.osxSign, false);
  assert.equal(resolved.packagerConfig.osxNotarize, undefined);
  const fuses = resolved.plugins.find(plugin => plugin.name === 'fuses').fusesConfig;
  assert.equal(fuses.resetAdHocDarwinSignature, false);
  [false, true, false, false, true, true].forEach((value, index) => assert.equal(fuses[index], value));
};
assertUnsigned(config);
config.hooks = { ...base.hooks, prePackage: async (resolved, ...args) => {
  assertUnsigned(resolved);
  if (base.hooks?.prePackage) await base.hooks.prePackage(resolved, ...args);
}};
const configLoader = require('@electron-forge/core/dist/util/forge-config');
// A config file path is insufficient: Forge auto-discovery can override it.
// Register the object and assert the actual resolved config in prePackage.
configLoader.registerForgeConfigForDirectory(root, config);
const packagePath = path.join(root, 'package.json');
const originalPackage = fs.readFileSync(packagePath, 'utf8');
const pkg = JSON.parse(originalPackage);
const output = path.join(root, 'integration-artifact');
fs.mkdirSync(output, { recursive: true });
try {
  fs.writeFileSync(packagePath, JSON.stringify({ ...pkg, productName: name, version }, null, 2) + '\n');
  const { api } = require('@electron-forge/core');
  await api.package({ dir: root, platform: 'darwin', arch: process.arch, interactive: false });
  const app = path.join(root, 'out', `${name}-darwin-${process.arch}`, `${name}.app`);
  const plist = path.join(app, 'Contents/Info.plist');
  const field = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  assert.equal(field('CFBundleIdentifier'), bundleId);
  assert.equal(field('CFBundleDisplayName'), name);
  assert.equal(field('CFBundleShortVersionString'), version);
  await assertHardenedFuseWire(app);
  const asar = fs.readFileSync(path.join(app, 'Contents/Resources/app.asar'));
  const manifest = { sourceCommit, runId, attempt, name, bundleId, version, platform: 'darwin', arch: process.arch,
    electron: pkg.devDependencies.electron, asarSha256: createHash('sha256').update(asar).digest('hex'),
    fuses: await getCurrentFuseWire(app), signing: false, notarization: false, implicitFuseSigning: false,
    packagedLaunchVerified: false, embeddedRuntimeExecuted: false };
  fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'README.txt'),
    `UNSIGNED TEST ARTIFACT — ${sourceCommit}\nNot a release or packaged-launch validation.\n` +
    'Do not launch without explicit authorization. Use a disposable CLUBHOUSE_USER_DATA profile,\n' +
    'CLUBHOUSE_DISABLE_AUTO_UPDATE=1, CLUBHOUSE_ANNEX_LOOPBACK_ONLY=1 and CLUBHOUSE_ANNEX_EPHEMERAL=1.\n' +
    'No URL-scheme registration is declared by this test bundle. No signing/trust workaround is supplied.\n');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app,
    path.join(output, `Clubhouse-Integration-${process.arch}-${sourceCommit.slice(0, 12)}.zip`)]);
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  fs.writeFileSync(packagePath, originalPackage);
  configLoader.unregisterForgeConfigForDirectory(root);
}
