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
//
// Options (flag or environment variable):
//   --fake-fixture <path>      CLUBHOUSE_FAKE_CLI_FIXTURE   fixture to replay (required)
//   --fake-report <path>       CLUBHOUSE_FAKE_CLI_REPORT    JSON progress report, rewritten after every step
//   --fake-speed <n>           CLUBHOUSE_FAKE_CLI_SPEED     timing multiplier; 0 (default) replays instantly, 1 is real time
//   --fake-max-delay-ms <n>    CLUBHOUSE_FAKE_CLI_MAX_DELAY_MS  cap for any single recorded gap (default 2000)
//   --fake-lenient             CLUBHOUSE_FAKE_CLI_LENIENT=1 skip client messages that don't match instead of failing

import { writeFileSync } from 'node:fs';
import {
  clientRequestId,
  loadFixture,
  matchClientMessage,
  remapCliMessage,
  splitLines,
} from './fixture-format.mjs';

const MISMATCH_EXIT_CODE = 3;

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

const report = {
  fixture: opts.fixture,
  protocol,
  argv: opts.cliArgs,
  total: entries.length,
  consumed: 0,
  complete: false,
  stdinClosed: false,
  mismatch: null,
  unexpected: [],
  exitCode: null,
};

function writeReport() {
  if (!opts.report) return;
  try {
    writeFileSync(opts.report, JSON.stringify(report, null, 2));
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
  writeReport();
  await replay();
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
      try {
        inbox.push(JSON.parse(line));
      } catch {
        inbox.push({ __unparsed: line });
      }
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
      if ('msg' in entry) {
        process.stdout.write(JSON.stringify(remapCliMessage(protocol, entry.msg, idMap)) + '\n');
      } else if ('raw' in entry) {
        process.stdout.write(entry.raw + '\n');
      } else if ('stderr' in entry) {
        process.stderr.write(entry.stderr.endsWith('\n') ? entry.stderr : entry.stderr + '\n');
      } else if ('exit' in entry) {
        report.consumed++;
        report.complete = report.consumed === report.total;
        finish(entry.exit.code ?? 0);
        return;
      }
      report.consumed++;
      writeReport();
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
