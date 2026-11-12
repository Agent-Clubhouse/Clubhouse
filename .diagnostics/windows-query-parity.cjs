'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync, spawnSync } = require('node:child_process');

const MARKER = 'CLUBHOUSE_QUERY:script-enter';
const PREFIX = `[Console]::Error.WriteLine('${MARKER}'); `;
const TAIL = ' | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
const ORIGINAL = `Get-CimInstance Win32_Process${TAIL}`;
const EXPECTED_PATHS = [
  'e2e/cleanup-process-table.ts',
  'test/e2e-process-table.test.ts',
  'test/checkpoint-fixture-lifetime.ts',
  'src/main/services/agent-runtime/checkpoint-fixture-lifetime.test.ts',
];
const UNCHANGED_PATHS = ['.github/workflows/validate.yml', 'vitest.config.ts', 'package.json', 'package-lock.json'];
const SHA = /^[a-f0-9]{40}$/;
const receipt = { purpose: 'diagnostic-only', ok: false, children: [], cases: [], realCim: null, failure: null };
let active;
let admissionStopped = false;

function requireCondition(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.fixedCode = code;
    throw error;
  }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function blob(root, name) {
  // Apply the checkout's existing clean/EOL rules; Windows CRLF is not a new
  // source blob. No -w, config changes, normalization writes or guard bypass.
  return git(root, ['hash-object', `--path=${name}`, '--', name]);
}

function safeConversionAttributes(root) {
  const names = EXPECTED_PATHS.concat(UNCHANGED_PATHS);
  const fields = git(root, ['check-attr', '-z', 'filter', 'working-tree-encoding', '--', ...names]).split('\0');
  requireCondition(fields.pop() === '' && fields.length === names.length * 6, 'source_conversion_rejected');
  const seen = new Set();
  for (let i = 0; i < fields.length; i += 3) {
    const [name, attribute, value] = fields.slice(i, i + 3);
    requireCondition(names.includes(name) && ['filter', 'working-tree-encoding'].includes(attribute)
      && ['unspecified', 'unset'].includes(value), 'source_conversion_rejected');
    const key = `${name}\0${attribute}`;
    requireCondition(!seen.has(key), 'source_conversion_rejected');
    seen.add(key);
  }
}

function gate(manifest) {
  const env = process.env;
  requireCondition(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_RUN_ATTEMPT === '1', 'event_or_attempt_rejected');
  requireCondition(env.GITHUB_REPOSITORY === manifest.expectedRepository, 'repository_rejected');
  requireCondition(SHA.test(env.EXPECTED_CONTROL_SHA || '') && env.EXPECTED_CONTROL_SHA === env.GITHUB_SHA, 'control_sha_rejected');
  requireCondition(git(process.cwd(), ['rev-parse', 'HEAD']) === env.GITHUB_SHA, 'control_checkout_rejected');
  requireCondition(manifest.runnable === true && SHA.test(manifest.captureSha || ''), 'manifest_not_approved');
  requireCondition(env.EXPECTED_CAPTURE_SHA === manifest.captureSha, 'capture_input_rejected');
  requireCondition(manifest.deadlineMs === 10000 && SHA.test(manifest.captureTree), 'manifest_shape_rejected');
  requireCondition(Object.keys(manifest.reviewedPaths).sort().join('\n') === EXPECTED_PATHS.slice().sort().join('\n'), 'reviewed_paths_rejected');
  for (const entry of Object.values(manifest.reviewedPaths)) {
    requireCondition(SHA.test(entry.before) && SHA.test(entry.after), 'reviewed_blob_rejected');
  }
  requireCondition(Object.keys(manifest.unchangedBlobs).sort().join('\n') === UNCHANGED_PATHS.slice().sort().join('\n'), 'unchanged_paths_rejected');
  requireCondition(Object.values(manifest.unchangedBlobs).every((sha) => SHA.test(sha)), 'reviewed_blob_rejected');
}

function checkoutConfig(root, key, allowed) {
  const result = spawnSync('git', ['config', '--get', key],
    { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  requireCondition(!result.error && (result.status === 0 || result.status === 1), 'checkout_config_unreadable');
  if (result.status === 1) return 'unset';
  const value = result.stdout.trim();
  requireCondition(allowed.includes(value), 'checkout_config_rejected');
  return value;
}

function runtime(manifest, root) {
  requireCondition(process.platform === 'win32' && os.release() === manifest.expectedOsRelease, 'os_drift');
  requireCondition(process.env.ImageVersion === manifest.expectedImageVersion, 'image_drift');
  requireCondition(process.version === manifest.expectedNodeVersion, 'node_drift');
  const npmVersion = execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm --version'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  requireCondition(npmVersion === manifest.expectedNpmVersion, 'npm_drift');
  return { osRelease: os.release(), imageVersion: process.env.ImageVersion, nodeVersion: process.version,
    npmVersion, availableParallelism: os.availableParallelism(),
    checkoutProof: 'git-clean-filtered-blobs',
    coreAutocrlf: checkoutConfig(root, 'core.autocrlf', ['true', 'false', 'input']),
    coreEol: checkoutConfig(root, 'core.eol', ['lf', 'crlf', 'native']) };
}

function verifySource(root, manifest) {
  requireCondition(git(root, ['rev-parse', 'HEAD']) === manifest.captureSha, 'source_sha_rejected');
  requireCondition(git(root, ['rev-parse', 'HEAD^{tree}']) === manifest.captureTree, 'source_tree_rejected');
  safeConversionAttributes(root);
  for (const name of EXPECTED_PATHS) {
    requireCondition(blob(root, name) === manifest.reviewedPaths[name].after, 'source_blob_rejected');
  }
  for (const [name, expected] of Object.entries(manifest.unchangedBlobs)) {
    requireCondition(blob(root, name) === expected, 'baseline_blob_rejected');
  }
}

function countMarkers(bytes) {
  let line = '', discard = false, count = 0;
  for (const char of bytes.toString('utf8')) {
    if (char === '\n') {
      if (!discard && (line === MARKER || line === `${MARKER}\r`)) count++;
      line = ''; discard = false;
    } else if (!discard) {
      if (line.length < 96) line += char;
      else { line = ''; discard = true; }
    }
  }
  return count;
}

async function query(label, script, deadlineMs) {
  requireCondition(!admissionStopped, 'query_admission_stopped');
  requireCondition(!active, 'prior_child_unreconciled');
  requireCondition(deadlineMs === 10000, 'query_deadline_rejected');
  const origin = performance.now();
  const timing = { label, spawned: false, callbackObserved: false, closeObserved: false,
    exitObserved: false, deadlineObserved: false, cleanupRequested: false,
    callbackKind: 'pending', exitCode: null, closeCode: null, signalObserved: false };
  const elapsed = () => Math.max(0, Math.round(performance.now() - origin));
  receipt.children.push(timing);
  return new Promise((resolve, reject) => {
    let child, stdout, stderr, callbackCode;
    const fail = (code) => {
      admissionStopped = true;
      reject(Object.assign(new Error(code), { fixedCode: code }));
    };
    const finish = () => {
      if (!timing.callbackObserved || !timing.closeObserved) return;
      clearTimeout(timer);
      if (active === child) active = undefined;
      if (timing.deadlineObserved) { fail('query_incomplete'); return; }
      if (timing.callbackKind === 'infrastructure' || !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr)) {
        fail('query_callback_infrastructure'); return;
      }
      if (!timing.spawned || !timing.exitObserved || timing.signalObserved || !Number.isSafeInteger(timing.exitCode)
        || timing.exitCode < 0 || timing.exitCode !== timing.closeCode || timing.closeCode !== callbackCode) {
        fail('query_lifecycle_invalid'); return;
      }
      resolve({ timing, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timing.deadlineObserved = true;
      timing.deadlineAtMs = elapsed();
      try { timing.cleanupRequested = child?.kill('SIGKILL') === true; } catch { timing.cleanupRequested = false; }
      fail('query_incomplete');
      // No replacement is admitted without callback AND close. The bounded job
      // itself must fail if those receipts never arrive; no second query/signal.
    }, deadlineMs);
    try {
      child = execFile('powershell.exe', ['-NoProfile', '-Command', script],
        { windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
        (error, output, errorOutput) => {
          stdout = output; stderr = errorOutput;
          if (error === null) {
            timing.callbackKind = 'success';
            callbackCode = 0;
          } else if (error && Number.isSafeInteger(error.code) && error.code > 0
            && error.killed === false && error.signal === null) {
            timing.callbackKind = 'numeric-exit';
            callbackCode = error.code;
          } else {
            timing.callbackKind = 'infrastructure';
            admissionStopped = true;
          }
          timing.callbackObserved = true; timing.callbackAtMs = elapsed();
          finish();
        });
      active = child;
      child.once('spawn', () => { timing.spawned = true; timing.spawnAtMs = elapsed(); });
      child.once('exit', (code, signal) => {
        timing.exitObserved = true; timing.exitCode = code;
        timing.signalObserved = signal !== null; timing.exitAtMs = elapsed();
      });
      child.once('close', (code, signal) => {
        timing.closeCode = code; timing.signalObserved ||= signal !== null;
        timing.closeObserved = true; timing.closeAtMs = elapsed();
        finish();
      });
    } catch {
      clearTimeout(timer);
      fail('query_creation_failed');
    }
  });
}

function validRows(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.every((row) => row && Number.isSafeInteger(row.ProcessId) && row.ProcessId >= 0
      && Number.isSafeInteger(row.ParentProcessId) && row.ParentProcessId >= 0
      && (row.CommandLine === null || typeof row.CommandLine === 'string'));
  } catch { return false; }
}

async function parity(root, manifest) {
  verifySource(root, manifest);
  receipt.sourceConversionSafe = true;
  receipt.runtime = runtime(manifest, root);
  const one = "[pscustomobject]@{ProcessId=123;ParentProcessId=1;CommandLine='CLUBHOUSE_PRIVATE_SENTINEL'}";
  const two = '[pscustomobject]@{ProcessId=124;ParentProcessId=1;CommandLine=$null}';
  const variants = [
    ['empty', '& { }'],
    ['single', `& { ${one} }`],
    ['multi', `& { ${one}; ${two} }`],
    ['partial-nonterminating-error', `& { ${one}; Write-Error 'CLUBHOUSE_PRIVATE_ERROR' }`],
    ['terminating-error', "& { throw 'CLUBHOUSE_PRIVATE_ERROR' }"],
  ];
  for (const [label, producer] of variants) {
    const original = await query(`${label}.original`, `${producer}${TAIL}`, manifest.deadlineMs);
    const candidate = await query(`${label}.candidate`, `${PREFIX}${producer}${TAIL}`, manifest.deadlineMs);
    const result = { label, stdoutEqual: original.stdout.equals(candidate.stdout),
      exitEqual: original.timing.exitCode === candidate.timing.exitCode,
      originalMarkerCount: countMarkers(original.stderr), candidateMarkerCount: countMarkers(candidate.stderr) };
    receipt.cases.push(result);
    requireCondition(result.stdoutEqual && result.exitEqual && result.originalMarkerCount === 0
      && result.candidateMarkerCount === 1, 'synthetic_parity_failed');
  }
  const original = await query('real-cim.original', ORIGINAL, manifest.deadlineMs);
  const candidate = await query('real-cim.candidate', PREFIX + ORIGINAL, manifest.deadlineMs);
  receipt.realCim = {
    originalValid: original.timing.exitCode === 0 && original.timing.callbackKind === 'success' && validRows(original.stdout),
    candidateValid: candidate.timing.exitCode === 0 && candidate.timing.callbackKind === 'success' && validRows(candidate.stdout),
    originalMarkerCount: countMarkers(original.stderr), candidateMarkerCount: countMarkers(candidate.stderr),
  };
  requireCondition(receipt.realCim.originalValid && receipt.realCim.candidateValid
    && receipt.realCim.originalMarkerCount === 0 && receipt.realCim.candidateMarkerCount === 1, 'real_cim_sanity_failed');
  receipt.ok = true;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'windows-query-manifest.json'), 'utf8'));
  gate(manifest);
  if (process.env.PARITY_MODE === 'gate') {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [
      `capture_sha=${manifest.captureSha}`,
      `capture_tree=${manifest.captureTree}`,
      `reviewed_blobs=${JSON.stringify(Object.fromEntries(EXPECTED_PATHS.map((name) => [name, manifest.reviewedPaths[name].after])))}`,
      `unchanged_blobs=${JSON.stringify(manifest.unchangedBlobs)}`,
      `image_version=${manifest.expectedImageVersion}`,
      `os_release=${manifest.expectedOsRelease}`,
      `node_version=${manifest.expectedNodeVersion}`,
      `npm_version=${manifest.expectedNpmVersion}`,
      '',
    ].join('\n'));
    return;
  }
  requireCondition(process.env.PARITY_MODE === 'parity', 'mode_rejected');
  await parity(path.resolve('candidate'), manifest);
}

main().catch((error) => {
  // Only locally-created fixed codes are admitted, never native errors/paths/args.
  const allowed = new Set(['event_or_attempt_rejected', 'repository_rejected', 'control_sha_rejected',
    'control_checkout_rejected', 'manifest_not_approved', 'capture_input_rejected', 'manifest_shape_rejected',
    'reviewed_paths_rejected', 'unchanged_paths_rejected', 'reviewed_blob_rejected', 'source_conversion_rejected',
    'os_drift', 'image_drift', 'node_drift', 'npm_drift',
    'source_sha_rejected', 'source_tree_rejected', 'source_blob_rejected', 'baseline_blob_rejected',
    'checkout_config_unreadable', 'checkout_config_rejected',
    'prior_child_unreconciled', 'query_admission_stopped', 'query_deadline_rejected', 'query_incomplete',
    'query_creation_failed', 'query_callback_infrastructure', 'query_lifecycle_invalid', 'synthetic_parity_failed',
    'real_cim_sanity_failed', 'mode_rejected']);
  receipt.failure = allowed.has(error?.fixedCode) ? error.fixedCode : 'internal_failure';
  process.exitCode = 1;
}).finally(() => {
  if (process.env.PARITY_MODE === 'gate' && receipt.failure === null) return;
  let summary = JSON.stringify(receipt);
  if (summary.includes('CLUBHOUSE_PRIVATE')) {
    summary = JSON.stringify({ purpose: 'diagnostic-only', ok: false, failure: 'privacy_check_failed' });
    process.exitCode = 1;
  }
  try {
    fs.mkdirSync('diagnostic-receipts', { recursive: true });
    fs.writeFileSync('diagnostic-receipts/parity.json', `${summary}\n`);
  } catch {
    console.log(JSON.stringify({ purpose: 'diagnostic-only', ok: false, failure: 'receipt_write_failed' }));
    process.exitCode = 1;
  }
  console.log(summary);
});
