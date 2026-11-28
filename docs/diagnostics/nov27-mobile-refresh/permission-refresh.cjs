// Run from the desktop checkout with its existing TypeScript dependency.
// No app startup. The two observation ports count requests to broadcast.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const ts = require('typescript');

const releases = {
  beta7: 'dc8e82236eb2ae8dadb6bd309297d0c157caaba4',
  beta8: '30fd3ab0fdca6dbe75aed0b91e4c9878eded9b71',
};
function source(revision, file) {
  return execFileSync('git', ['show', revision + ':src/main/services/' + file], { encoding: 'utf8' });
}
function compile(sourceText) {
  return ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function run(label, revision) {
  const ports = new Map([
    ['crypto', { randomUUID: () => 'fixture-request' }],
    ['./log-service', { appLog() {} }],
    ['../orchestrators/types', { PERMISSION_HOOK_TIMEOUT_SEC: 120 }],
  ]);
  const permissionQueue = {};
  vm.runInNewContext(compile(source(revision, 'annex-permission-queue.ts')), {
    exports: permissionQueue, setTimeout, clearTimeout,
    require(name) { assert(ports.has(name), name); return ports.get(name); },
  });
  const server = source(revision, 'annex-server.ts');
  const start = server.indexOf(label === 'beta7'
    ? '  unsubPermissionRequest = permissionQueue.onPermissionRequest('
    : '  const offPermissionRequest = permissionQueue.onPermissionRequest(');
  const end = server.indexOf('  unsubGroupProjectChanged = ', start);
  assert(start >= 0 && end > start);
  const observed = [];
  vm.runInNewContext(compile('let unsubPermissionRequest;\n' + server.slice(start, end)), {
    permissionQueue,
    broadcastAndBuffer(type) { observed.push(type); },
    broadcastSnapshotRefresh() { observed.push('request-snapshot'); },
  });
  try {
    permissionQueue.clearForAgent('absent');
    assert.equal(observed.length, 0);
    const { requestId } = permissionQueue.createPermission('fixture-agent', 'fixture-tool');
    const created = observed.splice(0);
    assert.equal(permissionQueue.cancelPermission(requestId, 'fixture-withdrawn'), true);
    const withdrawn = observed.splice(0);
    assert.equal(permissionQueue.cancelPermission(requestId, 'already-withdrawn'), false);
    assert.equal(observed.length, 0);
    assert.deepEqual(created, label === 'beta7' ? ['permission:request'] : ['permission:request', 'request-snapshot']);
    assert.deepEqual(withdrawn, label === 'beta7' ? [] : ['request-snapshot']);
    return { release: label, revision, created, withdrawn };
  } finally {
    permissionQueue.reset();
  }
}
for (const [label, revision] of Object.entries(releases)) console.log(JSON.stringify(run(label, revision)));
