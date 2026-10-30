#!/usr/bin/env node
// Fake coding CLI: replays a chat fixture over stdio so protocol drivers and
// E2E tests run against real protocol traffic without spending tokens.
//
//   node scripts/chat-fixtures/fake-cli.mjs --fake-fixture <file.jsonl> [real CLI args…]
//
// CLI lines (`from: "cli"`) are written to stdout/stderr in order. At each
// client line (`from: "client"`) the fake waits for the driver to send a
// matching message, then remaps ids so recorded responses answer the ids the
// driver actually used. A mismatch exits with code 3 and a diagnostic on
// stderr. Every other argument (`-p`, `app-server`, `--acp`, …) is accepted
// and recorded in the report, so a test can assert how the CLI was launched.
// The report also records the CLIs' state-dir variables (REPORTED_ENV), so a
// test can check the app passed them through to the CLI's environment.
//
// Standing queries: read-only requests a driver may send at any point (the
// applied model and effort, plan usage, the model list) are answered with an empty result
// whenever they arrive, unless the fixture records that request itself. So a
// fixture recorded before a driver started asking still replays. A fixture that
// records one must record every one the driver sends: the Claude driver reads
// get_settings at start, after model changes and after /model or /effort turns,
// and get_usage at start and after turns (at most every 30s).
//
// Options (flag or environment variable):
//   --fake-fixture <path>      CLUBHOUSE_FAKE_CLI_FIXTURE   fixture to replay (required)
//   --fake-report <path>       CLUBHOUSE_FAKE_CLI_REPORT    JSON progress report, rewritten after every step
//   --fake-speed <n>           CLUBHOUSE_FAKE_CLI_SPEED     timing multiplier; 0 (default) replays instantly, 1 is real time
//   --fake-max-delay-ms <n>    CLUBHOUSE_FAKE_CLI_MAX_DELAY_MS  cap for any single recorded gap (default 2000)
//   --fake-lenient             CLUBHOUSE_FAKE_CLI_LENIENT=1 skip client messages that don't match instead of failing

import { renameSync, writeFileSync } from 'node:fs';
import {
  clientRequestId,
  loadFixture,
  matchClientMessage,
  messageKey,
  remapCliMessage,
  splitLines,
} from './fixture-format.mjs';

const MISMATCH_EXIT_CODE = 3;

/** Where each real CLI keeps its state; reported as launched (null if unset). */
const REPORTED_ENV = ['COPILOT_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

function parseArgs(argv) {
  const env = process.env;
  const opts = {
    fixture: env.CLUBHOUSE_FAKE_CLI_FIXTURE,
    report: env.CLUBHOUSE_FAKE_CLI_REPORT,
    speed: Number(env.CLUBHOUSE_FAKE_CLI_SPEED ?? 0),
    maxDelayMs: Number(env.CLUBHOUSE_FAKE_CLI_MAX_DELAY_MS ?? 2000),
    lenient: env.CLUBHOUSE_FAKE_CLI_LENIENT === '1',
    cliArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fake-fixture') opts.fixture = argv[++i];
    else if (arg === '--fake-report') opts.report = argv[++i];
    else if (arg === '--fake-speed') opts.speed = Number(argv[++i]);
    else if (arg === '--fake-max-delay-ms') opts.maxDelayMs = Number(argv[++i]);
    else if (arg === '--fake-lenient') opts.lenient = true;
    else opts.cliArgs.push(arg);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.fixture) {
  process.stderr.write('fake-cli: no fixture (pass --fake-fixture <path> or set CLUBHOUSE_FAKE_CLI_FIXTURE)\n');
  process.exit(2);
}

const { header, entries } = await loadFixture(opts.fixture);
const protocol = header.protocol;

/** Empty answers to the standing queries, by message key (see the header comment). */
const STANDING_QUERIES = {
  'claude-stream-json': {
    'control_request:get_settings': (msg) => ({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } }),
    // No rate_limits: the driver shows no plan windows from it.
    'control_request:get_usage': (msg) => ({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } }),
  },
  'codex-app-server': {
    'request:model/list': (msg) => ({ id: msg.id, result: { data: [], nextCursor: null } }),
  },
};
const recordedKeys = new Set(entries.filter((e) => e.from === 'client' && e.msg).map((e) => messageKey(protocol, e.msg)));
const standing = Object.fromEntries(
  Object.entries(STANDING_QUERIES[protocol] ?? {}).filter(([key]) => !recordedKeys.has(key)),
);

/** Answer a standing query; false for anything the fixture should match. */
function answerStandingQuery(msg) {
  const answer = standing[messageKey(protocol, msg)];
  if (!answer) return false;
  process.stdout.write(JSON.stringify(answer(msg)) + '\n');
  return true;
}

const report = {
  pid: process.pid,
  fixture: opts.fixture,
  protocol,
  argv: opts.cliArgs,
  env: Object.fromEntries(REPORTED_ENV.map((name) => [name, process.env[name] ?? null])),
  total: entries.length,
  consumed: 0,
  complete: false,
  stdinClosed: false,
  mismatch: null,
  unexpected: [],
  exitCode: null,
};

const reportTmp = opts.report ? `${opts.report}.${process.pid}.tmp` : undefined;

/**
 * Rewrite the report atomically (temp file in the same directory, then
 * rename) so a test polling it never reads half a file. Windows refuses the
 * rename while a reader has the target open, so retry briefly.
 */
function writeReport() {
  if (!opts.report) return;
  try {
    writeFileSync(reportTmp, JSON.stringify(report, null, 2));
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(reportTmp, opts.report);
        return;
      } catch (err) {
        if (attempt >= 20) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } catch {
    // Reporting is best-effort; never let it break the replay.
  }
}

function finish(code) {
  report.exitCode = code;
  writeReport();
  // Exit only once everything already written to stdout has been handed off.
  process.stdout.write('', () => process.exit(code));
}

process.stdout.on('error', () => finish(0));

// `--version` answers from the header so version probes see the recorded CLI.
if (opts.cliArgs.includes('--version') && header.cli?.version) {
  process.stdout.write(`${header.cli.versionOutput ?? header.cli.version}\n`);
  finish(0);
} else {
  watchParent();
  writeReport();
  await replay();
}

/**
 * Exit when whatever launched us dies. On Windows a driver runs the fake
 * through cmd.exe (the `.cmd` shim), and killing cmd.exe leaves this node
 * process behind with its stdin still open: it would keep replaying and keep
 * its fixture and report files open, so a test's temp-dir cleanup fails.
 */
function watchParent() {
  const parent = process.ppid;
  const timer = setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      finish(0);
    }
  }, 250);
  timer.unref();
}

async function replay() {
  const inbox = [];
  let stdinBuffer = '';
  let wake = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const { lines, rest } = splitLines(stdinBuffer + chunk);
    stdinBuffer = rest;
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        inbox.push({ __unparsed: line });
        continue;
      }
      if (!answerStandingQuery(msg)) inbox.push(msg);
    }
    notify();
  });
  process.stdin.on('end', () => {
    report.stdinClosed = true;
    notify();
  });

  /** Next client message, or null once stdin has closed with nothing queued. */
  async function nextClientMessage() {
    while (inbox.length === 0) {
      if (report.stdinClosed) return null;
      await new Promise((resolve) => { wake = resolve; });
    }
    return inbox.shift();
  }

  const idMap = new Map();
  let lastT;

  for (const entry of entries) {
    if (typeof entry.t === 'number') {
      if (entry.from === 'cli' && opts.speed > 0 && lastT !== undefined) {
        const gap = Math.min((entry.t - lastT) * opts.speed, opts.maxDelayMs);
        if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      }
      lastT = entry.t;
    }

    if (entry.from === 'cli') {
      // Count the line before writing it: a driver may kill the CLI the
      // moment it reads the last line, before this process gets another turn.
      report.consumed++;
      report.complete = report.consumed === report.total;
      if ('exit' in entry) {
        finish(entry.exit.code ?? 0);
        return;
      }
      writeReport();
      if ('msg' in entry) {
        process.stdout.write(JSON.stringify(remapCliMessage(protocol, entry.msg, idMap)) + '\n');
      } else if ('raw' in entry) {
        process.stdout.write(entry.raw + '\n');
      } else if ('stderr' in entry) {
        process.stderr.write(entry.stderr.endsWith('\n') ? entry.stderr : entry.stderr + '\n');
      }
      continue;
    }

    // Client entry: wait for the driver to send the matching message.
    for (;;) {
      const actual = await nextClientMessage();
      if (actual === null) {
        // The driver hung up mid-fixture. A real CLI exits quietly here.
        finish(0);
        return;
      }
      const reason = '__unparsed' in actual
        ? `client sent a line that is not JSON: ${actual.__unparsed.slice(0, 200)}`
        : matchClientMessage(protocol, entry, actual);
      if (!reason) {
        const recordedId = clientRequestId(protocol, entry.msg);
        const liveId = clientRequestId(protocol, actual);
        if (recordedId !== undefined && liveId !== undefined) idMap.set(recordedId, liveId);
        break;
      }
      if (opts.lenient) {
        report.unexpected.push(actual);
        writeReport();
        continue;
      }
      report.mismatch = { line: entry.line, reason, actual };
      process.stderr.write(`fake-cli: fixture mismatch at ${opts.fixture}:${entry.line}: ${reason}\n`);
      finish(MISMATCH_EXIT_CODE);
      return;
    }
    report.consumed++;
    report.complete = report.consumed === report.total;
    writeReport();
  }

  report.complete = true;
  writeReport();

  // Like a real CLI, stay up until the driver closes stdin. Anything it sends
  // after the fixture ends is kept for the test to inspect.
  for (;;) {
    const extra = await nextClientMessage();
    if (extra === null) break;
    report.unexpected.push(extra);
    writeReport();
  }
  finish(0);
}
