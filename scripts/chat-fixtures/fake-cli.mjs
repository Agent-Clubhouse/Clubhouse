#!/usr/bin/env node
// Fake coding CLI: replays a chat fixture so protocol drivers and E2E tests run
// against real protocol traffic without spending tokens. Most protocols run over
// stdio. `copilot-sdk` runs like `copilot --headless --port 0`: it prints
// "listening on port <n>", then speaks `Content-Length` frames over TCP.
//
//   node scripts/chat-fixtures/fake-cli.mjs --fake-fixture <file.jsonl> [real CLI args…]
//
// CLI lines (`from: "cli"`) are written to stdout/stderr in order. At each
// client line (`from: "client"`) the fake waits for the driver to send a
// matching message, then remaps ids so recorded responses answer the ids the
// driver actually used. A mismatch exits with code 3 and a diagnostic on
// stderr. Every other argument (`-p`, `app-server`, `--acp`, …) is accepted
// and recorded in the report, so a test can assert how the CLI was launched.
// The report also records the CLIs' state-dir variables and Clubhouse's bridge
// variables (REPORTED_ENV), so a test can check the app passed them through to
// the CLI's environment, and call MCP tools as the agent.
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
//
// For `copilot-sdk`, a recorded session id is replaced with the one the driver
// chose, since clients pick their own. A `connect` with the wrong
// COPILOT_CONNECTION_TOKEN is refused. A header with `"listen": false` never opens the port.

import { renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import {
  TCP_PROTOCOLS,
  clientRequestId,
  clientSessionId,
  encodeFrame,
  loadFixture,
  matchClientMessage,
  messageKey,
  remapCliMessage,
  remapSessionIds,
  splitFrames,
  splitLines,
} from './fixture-format.mjs';

const MISMATCH_EXIT_CODE = 3;

/** Where each real CLI keeps its state; reported as launched (null if unset). */
const REPORTED_ENV = ['COPILOT_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLUBHOUSE_AGENT_ID', 'CLUBHOUSE_HOOK_NONCE', 'CLUBHOUSE_MCP_PORT'];

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
  'copilot-sdk': {
    'request:models.list': (msg) => ({ jsonrpc: '2.0', id: msg.id, result: { models: [] } }),
    'request:session.commands.list': (msg) => ({ jsonrpc: '2.0', id: msg.id, result: { commands: [] } }),
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
  wire.write(answer(msg));
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

let wire;

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
  // Exit only once everything already written has been handed off.
  const exit = () => process.stdout.write('', () => process.exit(code));
  if (wire?.drain) wire.drain(exit);
  else exit();
}

process.stdout.on('error', () => finish(0));

// `--version` answers from the header so version probes see the recorded CLI.
if (opts.cliArgs.includes('--version') && header.cli?.version) {
  process.stdout.write(`${header.cli.versionOutput ?? header.cli.version}\n`);
  finish(0);
} else if (TCP_PROTOCOLS.includes(protocol) && !(opts.cliArgs.includes('--headless') && opts.cliArgs.includes('--port'))) {
  process.stderr.write('fake-cli: copilot-sdk needs --headless --port <n>\n');
  finish(2);
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

/** One JSON message per line on stdin and stdout. The CLI exits when stdin closes. */
function stdioWire(onLine, onClose) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const { lines, rest } = splitLines(buffer + chunk);
    buffer = rest;
    for (const line of lines) onLine(line);
  });
  process.stdin.on('end', onClose);
  return {
    ready: async () => {},
    write: (msg) => process.stdout.write(JSON.stringify(msg) + '\n'),
    exitsWhenClosed: true,
  };
}

/**
 * `Content-Length` frames over TCP, on 127.0.0.1 like the real CLI. It starts
 * listening at the first entry that needs a connection, so a fixture can exit
 * during launch without ever printing the port. The CLI outlives a client that
 * disconnects: only being killed stops it.
 */
function tcpWire(onLine, onClose) {
  const portArg = opts.cliArgs.indexOf('--port');
  let socket = null;
  const backlog = [];
  const server = createServer((connection) => {
    socket = connection;
    let buffer = Buffer.alloc(0);
    connection.on('error', () => {});
    connection.on('data', (chunk) => {
      let bodies;
      try {
        ({ bodies, rest: buffer } = splitFrames(Buffer.concat([buffer, chunk])));
      } catch (err) {
        onLine(err.message);
        return;
      }
      for (const body of bodies) onLine(body);
    });
    connection.on('close', () => {
      if (socket === connection) socket = null;
      onClose();
    });
    for (const msg of backlog.splice(0)) connection.write(encodeFrame(msg));
  });
  let listening;
  return {
    ready() {
      listening ??= new Promise((resolve) => {
        if (header.listen === false) {
          // A CLI stuck in launch: stay up, and never print the port.
          setInterval(() => {}, 60_000);
          return;
        }
        server.listen(Number(opts.cliArgs[portArg + 1]), '127.0.0.1', () => {
          process.stdout.write(`CLI server listening on port ${server.address().port}\n`);
          resolve();
        });
      });
      return listening;
    },
    write(msg) {
      if (socket) socket.write(encodeFrame(msg));
      else backlog.push(msg);
    },
    drain(done) {
      if (socket) socket.write('', done);
      else done();
    },
    exitsWhenClosed: false,
  };
}

/** A wrong or missing connection token gets what the real CLI answers, and the fixture stops there. */
function refuseConnection(msg) {
  const token = process.env.COPILOT_CONNECTION_TOKEN;
  if (protocol !== 'copilot-sdk' || msg.method !== 'connect' || !token || msg.params?.token === token) return false;
  wire.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'AUTHENTICATION_FAILED: Invalid connection token' } });
  report.mismatch = { line: 0, reason: 'connect had the wrong connection token', actual: { method: msg.method } };
  process.stderr.write('fake-cli: connect had the wrong connection token\n');
  finish(MISMATCH_EXIT_CODE);
  return true;
}

async function replay() {
  const inbox = [];
  let wake = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  const makeWire = TCP_PROTOCOLS.includes(protocol) ? tcpWire : stdioWire;
  wire = makeWire((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      inbox.push({ __unparsed: line });
      notify();
      return;
    }
    if (!refuseConnection(msg) && !answerStandingQuery(msg)) inbox.push(msg);
    notify();
  }, () => {
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

  /** The driver hung up. A real CLI on stdio exits quietly; one on TCP waits to be killed. */
  async function clientGone() {
    writeReport();
    if (wire.exitsWhenClosed) finish(0);
    else await new Promise(() => {});
  }

  const idMap = new Map();
  const sessionIds = new Map();
  let lastT;

  for (const entry of entries) {
    if (typeof entry.t === 'number') {
      if (entry.from === 'cli' && opts.speed > 0 && lastT !== undefined) {
        const gap = Math.min((entry.t - lastT) * opts.speed, opts.maxDelayMs);
        if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      }
      lastT = entry.t;
    }

    if (entry.from === 'client' || 'msg' in entry) await wire.ready();

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
        wire.write(remapSessionIds(remapCliMessage(protocol, entry.msg, idMap), sessionIds));
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
        await clientGone();
        return;
      }
      const reason = '__unparsed' in actual
        ? `client sent a line that is not JSON: ${actual.__unparsed.slice(0, 200)}`
        : matchClientMessage(protocol, entry, actual);
      if (!reason) {
        const recordedId = clientRequestId(protocol, entry.msg);
        const liveId = clientRequestId(protocol, actual);
        if (recordedId !== undefined && liveId !== undefined) idMap.set(recordedId, liveId);
        const recordedSession = clientSessionId(protocol, entry.msg);
        const liveSession = clientSessionId(protocol, actual);
        if (recordedSession && liveSession && recordedSession !== liveSession) sessionIds.set(recordedSession, liveSession);
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

  await wire.ready();
  report.complete = true;
  writeReport();

  // Like a real CLI, stay up until the driver hangs up. Anything it sends
  // after the fixture ends is kept for the test to inspect.
  for (;;) {
    const extra = await nextClientMessage();
    if (extra === null) break;
    report.unexpected.push(extra);
    writeReport();
  }
  await clientGone();
}
