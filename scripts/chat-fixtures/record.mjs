#!/usr/bin/env node
// Record a chat fixture from a real CLI session. See docs/chat-fixtures.md.
//
//   node scripts/chat-fixtures/record.mjs --protocol <p> --out <file.jsonl> [options] -- <cli> [args…]
//
// Two modes:
//   Proxy (default): the recorder sits between a driver and the CLI. Its own
//     stdin goes to the CLI and the CLI's stdout comes back on its stdout, so
//     any driver (a protocol client, the Agent SDK via
//     pathToClaudeCodeExecutable, a test) can be pointed at it. Both
//     directions are captured.
//   Script (--script <steps.jsonl>): the recorder is the driver. Each step is
//     one of
//       {"send": <message>}                      write a client message
//       {"await": <partial>, "save": "name"}     wait for a CLI message containing <partial>
//       {"sleep": <ms>}                          pause
//       {"close": true}                          close the CLI's stdin
//     and "{{name.path}}" placeholders in a sent message read from saved
//     messages ("last" is always the most recent await).
//
// `copilot-sdk` runs over TCP: `-- copilot --headless --port 0`. The recorder
// reads the CLI's port and connects to it. As a proxy it opens its own port and
// prints "listening on port <n>", so a driver can use it as the binary. The
// connection token comes from COPILOT_CONNECTION_TOKEN, or is generated in
// script mode as "{{connectionToken}}", and is always redacted.
//
// Options:
//   --protocol claude-stream-json | codex-app-server | acp | copilot-sdk   (required)
//   --out <path>                fixture to write (required)
//   --description <text>        what the session covers
//   --cli-name <name> --cli-version <version>   recorded in the header
//   --script <path>             run a scripted session instead of proxying
//   --await-timeout-ms <n>      per-await timeout in script mode (default 120000)
//   --redact <from>=<to>        extra string replacement, repeatable
//   --redact-regex <re>=<to>    extra regex replacement (global), repeatable
//   --no-default-redactions     keep the home directory and cwd verbatim
//
// By default the cwd, home and temp directories become stable placeholders,
// and key-, token- and email-shaped strings are scrubbed. Review the output before committing: account emails, org names,
// MCP server names and slash commands come from your machine.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import {
  FIXTURE_FORMAT,
  FIXTURE_VERSION,
  LISTENING_RE,
  PROTOCOLS,
  REDACTED_CONNECTION_TOKEN,
  SECRET_REDACTIONS,
  TCP_PROTOCOLS,
  deepSubset,
  encodeFrame,
  fillTemplate,
  redactValue,
  serializeFixture,
  splitFrames,
  splitLines,
} from './fixture-format.mjs';

const REDACTED_CWD = '/workspace/project';
const REDACTED_HOME = '/home/user';
const REDACTED_TMP = '/tmp';

function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep === -1 || sep === argv.length - 1) {
    throw new Error('usage: record.mjs --protocol <p> --out <file> [options] -- <cli> [args…]');
  }
  const own = argv.slice(0, sep);
  const [command, ...commandArgs] = argv.slice(sep + 1);
  const opts = {
    command,
    commandArgs,
    redactions: [],
    defaultRedactions: true,
    awaitTimeoutMs: 120_000,
  };
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    const next = () => {
      if (i + 1 >= own.length) throw new Error(`${arg} needs a value`);
      return own[++i];
    };
    if (arg === '--protocol') opts.protocol = next();
    else if (arg === '--out') opts.out = next();
    else if (arg === '--description') opts.description = next();
    else if (arg === '--cli-name') opts.cliName = next();
    else if (arg === '--cli-version') opts.cliVersion = next();
    else if (arg === '--script') opts.script = next();
    else if (arg === '--await-timeout-ms') opts.awaitTimeoutMs = Number(next());
    else if (arg === '--no-default-redactions') opts.defaultRedactions = false;
    else if (arg === '--redact') {
      const value = next();
      const eq = value.indexOf('=');
      if (eq <= 0) throw new Error(`--redact expects <from>=<to>, got ${value}`);
      opts.redactions.push([value.slice(0, eq), value.slice(eq + 1)]);
    } else if (arg === '--redact-regex') {
      const value = next();
      const eq = value.lastIndexOf('=');
      if (eq <= 0) throw new Error(`--redact-regex expects <pattern>=<to>, got ${value}`);
      opts.redactions.push([new RegExp(value.slice(0, eq), 'g'), value.slice(eq + 1)]);
    } else throw new Error(`unknown option ${arg}`);
  }
  if (!PROTOCOLS.includes(opts.protocol)) {
    throw new Error(`--protocol must be one of ${PROTOCOLS.join(', ')}`);
  }
  if (!opts.out) throw new Error('--out is required');
  return opts;
}

/**
 * Pairs applied to every string in the recording. Literal paths go longest
 * first so the cwd wins over the home directory it sits in; secret-shaped
 * patterns run after.
 */
function redactionPairs(opts) {
  const literals = opts.redactions.filter(([from]) => typeof from === 'string');
  const patterns = opts.redactions.filter(([from]) => from instanceof RegExp);
  if (opts.defaultRedactions) {
    // Each directory as given and resolved: macOS reports /var/… for the
    // temp dir while tools print /private/var/…, and Windows runners give a
    // short-name temp path.
    for (const [dir, to] of [[process.cwd(), REDACTED_CWD], [homedir(), REDACTED_HOME], [tmpdir(), REDACTED_TMP]]) {
      literals.push([dir, to]);
      // The native resolver also expands Windows 8.3 short names
      // (C:\Users\RUNNER~1\…), which the JS one leaves alone.
      for (const resolve of [realpathSync.native, realpathSync]) {
        try {
          const real = resolve(dir);
          if (!literals.some(([from]) => from === real)) literals.push([real, to]);
        } catch {}
      }
    }
    patterns.push(...SECRET_REDACTIONS);
  }
  literals.sort((a, b) => b[0].length - a[0].length);
  return [...literals, ...patterns];
}

/** Call `onBody` with each `Content-Length` frame body read from a stream. */
function readFrames(stream, onBody) {
  let buffer = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    const { bodies, rest } = splitFrames(Buffer.concat([buffer, chunk]));
    buffer = rest;
    for (const body of bodies) onBody(body);
  });
}

/**
 * npm-installed CLIs are .cmd shims on Windows, which only cmd.exe can run,
 * so route through it there with each argument quoted.
 */
function spawnCli(command, args, options = {}) {
  const stdio = [options.stdin ?? 'pipe', 'pipe', 'pipe'];
  const env = options.env ?? process.env;
  if (process.platform !== 'win32') {
    return spawn(command, args, { stdio, env });
  }
  const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
  const line = [command, ...args].map(quote).join(' ');
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    stdio,
    env,
    windowsVerbatimArguments: true,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tcp = TCP_PROTOCOLS.includes(opts.protocol);
  const scriptMode = Boolean(opts.script);
  const connectionToken = tcp ? process.env.COPILOT_CONNECTION_TOKEN ?? (scriptMode ? randomBytes(32).toString('hex') : undefined) : undefined;
  if (connectionToken) opts.redactions.push([connectionToken, REDACTED_CONNECTION_TOKEN]);
  const pairs = redactionPairs(opts);
  const steps = scriptMode
    ? (await readFile(opts.script, 'utf8')).split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
    : [];

  const started = Date.now();
  const entries = [];
  const t = () => Date.now() - started;
  const cliMessages = [];
  let wake = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  const child = spawnCli(opts.command, opts.commandArgs, tcp
    ? { stdin: 'ignore', env: { ...process.env, ...(connectionToken && { COPILOT_CONNECTION_TOKEN: connectionToken }) } }
    : {});
  // Writes after the CLI has gone (or never started) are dropped, not fatal.
  child.stdin?.on('error', () => {});

  let outBuffer = '';
  let announcePort;
  const cliPort = new Promise((resolve) => { announcePort = resolve; });
  // We stopped the CLI ourselves, so its exit isn't part of the session.
  let stopping = false;
  const recordLine = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      entries.push({ from: 'cli', t: t(), raw: line });
      return;
    }
    entries.push({ from: 'cli', t: t(), msg });
    cliMessages.push(msg);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (!scriptMode && !tcp) process.stdout.write(chunk);
    const { lines, rest } = splitLines(outBuffer + chunk);
    outBuffer = rest;
    for (const line of lines) {
      // On TCP, stdout is only launch output. Each run has its own port.
      const port = tcp ? LISTENING_RE.exec(line)?.[1] : undefined;
      if (port) {
        announcePort(Number(port));
        continue;
      }
      if (!tcp) {
        recordLine(line);
        continue;
      }
      if (!scriptMode) process.stdout.write(line + '\n');
      entries.push({ from: 'cli', t: t(), raw: line });
    }
    notify();
  });

  // Settle on `close`, not `exit`: `exit` can fire before the last stdout
  // chunk is read. A spawn failure emits `error` instead and is recorded as
  // exit code 127, like a shell's "command not found".
  let exited = false;
  let exitCode = 0;
  const exitPromise = new Promise((resolve) => {
    const settle = (entry) => {
      if (exited) return;
      exited = true;
      exitCode = stopping ? 0 : entry.exit.code;
      if (!stopping) entries.push(entry);
      notify();
      resolve();
    };
    child.on('close', (code, signal) => {
      if (outBuffer.trim()) recordLine(outBuffer.replace(/\r$/, ''));
      outBuffer = '';
      settle({ from: 'cli', t: t(), exit: { code: code ?? (signal ? 1 : 0) } });
    });
    child.on('error', (err) => {
      process.stderr.write(`record: failed to start ${opts.command}: ${err.message}\n`);
      settle({ from: 'cli', t: t(), exit: { code: 127 }, error: err.message });
    });
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    entries.push({ from: 'cli', t: t(), stderr: chunk });
  });

  let cliSocket = null;
  const sendToCli = (line) => {
    if (tcp) cliSocket?.write(encodeFrame(JSON.parse(line)));
    else if (!child.stdin.writable) return;
    else child.stdin.write(line.endsWith('\n') ? line : line + '\n');
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      entries.push({ from: 'client', t: t(), msg: JSON.parse(trimmed) });
    } catch {
      process.stderr.write(`record: client sent a non-JSON line (not recorded): ${trimmed.slice(0, 200)}\n`);
    }
  };

  /** Connect to the CLI's port, recording what it sends. Null if it exited first. */
  const connectToCli = async () => {
    const port = await Promise.race([cliPort, exitPromise]);
    if (port === undefined) return null;
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => {});
    readFrames(socket, (body) => {
      recordLine(body);
      notify();
    });
    await new Promise((resolve) => socket.once('connect', resolve));
    return socket;
  };

  if (scriptMode) {
    if (tcp) cliSocket = await connectToCli();
    const scope = connectionToken ? { connectionToken } : {};
    let cursor = 0; // index into cliMessages already considered by awaits
    for (const step of steps) {
      if ('send' in step) {
        sendToCli(JSON.stringify(fillTemplate(step.send, scope)));
      } else if ('await' in step) {
        const deadline = Date.now() + (step.timeoutMs ?? opts.awaitTimeoutMs);
        let found;
        while (!found) {
          for (; cursor < cliMessages.length; cursor++) {
            if (deepSubset(step.await, cliMessages[cursor])) {
              found = cliMessages[cursor++];
              break;
            }
          }
          if (found) break;
          if (exited) throw new Error(`CLI exited while awaiting ${JSON.stringify(step.await)}`);
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error(`timed out awaiting ${JSON.stringify(step.await)}`);
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, remaining);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        scope.last = found;
        if (step.save) scope[step.save] = found;
      } else if ('sleep' in step) {
        await new Promise((resolve) => setTimeout(resolve, step.sleep));
      } else if (step.close) {
        child.stdin?.end();
      } else {
        throw new Error(`unknown script step ${JSON.stringify(step)}`);
      }
    }
    child.stdin?.end();
    if (tcp) {
      stopping = true;
      cliSocket?.destroy();
      child.kill();
    }
    const grace = setTimeout(() => child.kill(), 10_000);
    await exitPromise;
    clearTimeout(grace);
  } else if (tcp) {
    // Each direction goes through untouched, and is recorded on the way.
    const proxy = createServer((client) => {
      client.on('error', () => {});
      void connectToCli().then((upstream) => {
        if (!upstream) {
          client.destroy();
          return;
        }
        cliSocket = upstream;
        upstream.on('data', (chunk) => client.write(chunk));
        upstream.on('close', () => client.destroy());
        // A driver makes one connection, so its hanging up ends the session. Windows
        // has no SIGTERM to catch. If the CLI went first, that exit is part of the recording.
        client.on('close', () => {
          if (upstream.destroyed) return;
          stopping = true;
          upstream.destroy();
          child.kill();
        });
        const forward = (chunk) => upstream.write(chunk);
        client.on('data', forward);
        readFrames(client, (body) => entries.push({ from: 'client', t: t(), msg: JSON.parse(body) }));
      });
    });
    void Promise.race([cliPort, exitPromise]).then((port) => {
      if (port === undefined) return;
      proxy.listen(0, '127.0.0.1', () => process.stdout.write(`CLI server listening on port ${proxy.address().port}\n`));
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        stopping = true;
        child.kill(signal);
      });
    }
    await exitPromise;
  } else {
    let inBuffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      const { lines, rest } = splitLines(inBuffer + chunk);
      inBuffer = rest;
      for (const line of lines) sendToCli(line);
    });
    process.stdin.on('end', () => {
      if (inBuffer.trim()) sendToCli(inBuffer);
      child.stdin.end();
    });
    // A driver that kills the recorder should still leave a fixture behind.
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => child.kill(signal));
    }
    await exitPromise;
  }

  const header = {
    kind: 'header',
    format: FIXTURE_FORMAT,
    version: FIXTURE_VERSION,
    protocol: opts.protocol,
    cli: {
      name: opts.cliName ?? opts.command.split(/[\\/]/).pop(),
      ...(opts.cliVersion ? { version: opts.cliVersion } : {}),
    },
    source: 'recorded',
    recordedAt: new Date(started).toISOString(),
    args: redactValue(opts.commandArgs, pairs),
    ...(opts.description ? { description: opts.description } : {}),
  };
  await writeFile(opts.out, serializeFixture(header, redactValue(entries, pairs)));
  process.stderr.write(`record: wrote ${entries.length} entries to ${opts.out}\n`);
  process.exitCode = exitCode;
  // The proxy's listener would keep the process up.
  if (tcp) process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`record: ${err.message}\n`);
  process.exit(1);
});
