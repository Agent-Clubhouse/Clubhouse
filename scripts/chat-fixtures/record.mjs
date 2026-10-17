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
// Options:
//   --protocol claude-stream-json | codex-app-server | acp   (required)
//   --out <path>                fixture to write (required)
//   --description <text>        what the session covers
//   --cli-name <name> --cli-version <version>   recorded in the header
//   --script <path>             run a scripted session instead of proxying
//   --await-timeout-ms <n>      per-await timeout in script mode (default 120000)
//   --redact <from>=<to>        extra string replacement, repeatable
//   --no-default-redactions     keep the home directory and cwd verbatim
//
// The home directory and cwd are replaced with stable placeholders by
// default. Review the output before committing: account emails, org names,
// MCP server names and slash commands come from your machine.

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  FIXTURE_FORMAT,
  FIXTURE_VERSION,
  PROTOCOLS,
  deepSubset,
  fillTemplate,
  redactValue,
  serializeFixture,
  splitLines,
} from './fixture-format.mjs';

const REDACTED_CWD = '/workspace/project';
const REDACTED_HOME = '/home/user';

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
    } else throw new Error(`unknown option ${arg}`);
  }
  if (!PROTOCOLS.includes(opts.protocol)) {
    throw new Error(`--protocol must be one of ${PROTOCOLS.join(', ')}`);
  }
  if (!opts.out) throw new Error('--out is required');
  return opts;
}

/** Pairs applied to every string in the recording, longest first so the cwd wins over the home directory it sits in. */
function redactionPairs(opts) {
  const pairs = [...opts.redactions];
  if (opts.defaultRedactions) {
    pairs.push([process.cwd(), REDACTED_CWD], [homedir(), REDACTED_HOME]);
  }
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

/**
 * npm-installed CLIs are .cmd shims on Windows, which only cmd.exe can run,
 * so route through it there with each argument quoted.
 */
function spawnCli(command, args) {
  if (process.platform !== 'win32') {
    return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
  const line = [command, ...args].map(quote).join(' ');
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsVerbatimArguments: true,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pairs = redactionPairs(opts);
  const scriptMode = Boolean(opts.script);
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

  const child = spawnCli(opts.command, opts.commandArgs);
  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      entries.push({ from: 'cli', t: t(), exit: { code: code ?? (signal ? 1 : 0) } });
      notify();
      resolve();
    });
    child.on('error', (err) => {
      process.stderr.write(`record: failed to start ${opts.command}: ${err.message}\n`);
      exited = true;
      notify();
      resolve();
    });
  });

  let outBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (!scriptMode) process.stdout.write(chunk);
    const { lines, rest } = splitLines(outBuffer + chunk);
    outBuffer = rest;
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        entries.push({ from: 'cli', t: t(), raw: line });
        continue;
      }
      entries.push({ from: 'cli', t: t(), msg });
      cliMessages.push(msg);
    }
    notify();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    entries.push({ from: 'cli', t: t(), stderr: chunk });
  });

  const sendToCli = (line) => {
    if (!child.stdin.writable) return;
    child.stdin.write(line.endsWith('\n') ? line : line + '\n');
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      entries.push({ from: 'client', t: t(), msg: JSON.parse(trimmed) });
    } catch {
      process.stderr.write(`record: client sent a non-JSON line (not recorded): ${trimmed.slice(0, 200)}\n`);
    }
  };

  if (scriptMode) {
    const scope = {};
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
        child.stdin.end();
      } else {
        throw new Error(`unknown script step ${JSON.stringify(step)}`);
      }
    }
    child.stdin.end();
    const grace = setTimeout(() => child.kill(), 10_000);
    await exitPromise;
    clearTimeout(grace);
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
  process.exitCode = child.exitCode ?? 0;
}

main().catch((err) => {
  process.stderr.write(`record: ${err.message}\n`);
  process.exit(1);
});
