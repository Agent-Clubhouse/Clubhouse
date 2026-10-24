// Hosted Linux only: execute the real hardened package, never the dev entry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getCurrentFuseWire } from '@electron/fuses';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Hosted CI only');
assert.equal(process.platform, 'linux');
assert.equal(path.resolve(process.env.GITHUB_WORKSPACE || ''), root);
assert.notEqual(process.getuid(), 0, 'Do not disable the sandbox to run as root');
const binary = path.join(root, 'out', `Clubhouse-linux-${process.arch}`, 'clubhouse');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const fuses = await getCurrentFuseWire(binary);
// Fuse wire values are ASCII '0'/'1'. Do not modify the binary to test it.
[48, 49, 48, 48, 49, 49].forEach((value, index) => assert.equal(fuses[index], value));
const output = path.join(root, 'packaged-runtime-evidence');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-packaged-ci-'));
const seed = (name, value) => fs.writeFileSync(path.join(profile, name), JSON.stringify(value));
seed('experimental-settings.json', { telemetry: false });
seed('logging-settings.json', { enabled: true, minLogLevel: 'info', telemetryRecording: false });
seed('annex-settings.json', { enabled: false, enableServer: false, enableClient: false });
// Keep only basic display/runtime variables; never pass CI credentials to the app.
const env = Object.fromEntries(['PATH', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'LANG', 'LD_LIBRARY_PATH']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, {
  CLUBHOUSE_USER_DATA: profile, CLUBHOUSE_DISABLE_AUTO_UPDATE: '1',
  CLUBHOUSE_ANNEX_LOOPBACK_ONLY: '1', CLUBHOUSE_ANNEX_EPHEMERAL: '1',
});
const child = spawn(binary, [], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let consoleOutput = '';
let spawnError;
child.on('error', error => { spawnError = error; });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  consoleOutput = (consoleOutput + chunk.toString()).slice(-1024 * 1024);
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exited = new Promise(resolve => child.once('close', resolve));
try {
  const logDir = path.join(profile, '.clubhouse', 'logs');
  let runtime;
  const deadline = Date.now() + 30_000;
  while (!runtime && Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'Packaged app exited before runtime reporting');
    assert.equal(child.signalCode, null, 'Packaged app was terminated before runtime reporting');
    for (const name of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
      if (!name.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(logDir, name), 'utf8').split('\n')) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.t === 'diag' && record.ns === 'core:startup' && record.meta?.packaged === true) runtime = record.meta;
      }
    }
    if (!runtime) await pause(250);
  }
  assert.ok(runtime, 'No packaged runtime report within 30 seconds');
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.electron, pkg.devDependencies.electron);
  assert.match(runtime.node, /^\d+\.\d+\.\d+$/);
  assert.match(runtime.chrome, /^\d+\.\d+\.\d+\.\d+$/);
  await pause(2000);
  assert.equal(child.exitCode, null, 'Packaged app exited immediately after startup');
  assert.equal(child.signalCode, null);
  const evidence = {
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    runtime, fuses, binarySha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    scope: 'Actual packaged Linux startup; no renderer automation, Annex pairing or network probe',
  };
  fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* owned group already exited */ }
    await Promise.race([exited, pause(5000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* owned group already exited */ }
  }
  fs.writeFileSync(path.join(output, 'console.log'), consoleOutput);
  fs.rmSync(profile, { recursive: true, force: true });
}
