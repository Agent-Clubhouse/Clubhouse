#!/usr/bin/env node
/**
 * The clubhouse CLI (#2598): list projects and agents and change their display
 * settings, from a normal shell, through the running app. It never touches a
 * config file: without the app it stops with an error.
 *
 * The app copies this file out when the user installs the command. The packaged
 * app can't run scripts itself (its RunAsNode fuse is off), so it runs on `node`
 * from PATH, as the MCP bridge does.
 *
 * No external dependencies: uses only Node.js built-ins.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const EXIT = { ok: 0, failed: 1, usage: 2, notRunning: 3, refused: 4, notFound: 5, auth: 6 };
const REQUEST_TIMEOUT_MS = 30000;
const TOKEN_HEADER = 'x-clubhouse-cli-token';

const USAGE = `Usage: clubhouse <command> [options]

Commands:
  projects                     List projects
  agents [--project <ref>]     List agents, in one project or all of them
  project set <ref> [--display-name <name>] [--color <color>] [--emoji <emoji>] [--image <path>]
                               Change a project. <ref> is its id, path or name.
  agent set <id> [--color <color>] [--emoji <emoji>] [--image <path>]
                               Change an agent
  help                         Show this

An empty value clears a setting, as in --emoji "". An agent's color can't be cleared.

Options:
  --json   Print JSON, errors included
  --dev    Use a development build of Clubhouse (or set CLUBHOUSE_CLI_DEV=1)

Exit codes:
  0  Done
  1  Something unexpected went wrong
  2  The command line is wrong
  3  Clubhouse isn't running
  4  Clubhouse refused the change
  5  No such project or agent
  6  The token was refused or can't be read
`;

const COMMON_FLAGS = { '--json': 'json', '--dev': 'dev' };
const COMMANDS = {
  projects: { positional: [], values: {} },
  agents: { positional: [], values: { '--project': 'project' } },
  'project set': {
    positional: ['project'],
    values: { '--display-name': 'displayName', '--color': 'color', '--emoji': 'emoji', '--image': 'image' },
  },
  'agent set': {
    positional: ['agentId'],
    values: { '--color': 'color', '--emoji': 'emoji', '--image': 'image' },
  },
};

class CliError extends Error {
  constructor(exitCode, code, message) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}

function usageError(message) {
  return new CliError(EXIT.usage, 'usage', message);
}

/** What the command line asks for, or a usage error. Global flags can go anywhere. */
function parseArgs(argv) {
  const words = [];
  const options = {};
  const flags = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { command: 'help', options: {} };
    if (COMMON_FLAGS[arg]) {
      options[COMMON_FLAGS[arg]] = true;
    } else if (arg.startsWith('-') && arg.length > 1) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags.push([arg.slice(0, eq), arg.slice(eq + 1)]);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw usageError(`${arg} needs a value.`);
        flags.push([arg, next]);
        i++;
      }
    } else {
      words.push(arg);
    }
  }
  if (words.length === 0 || words[0] === 'help') return { command: 'help', options };
  const name = words[0] === 'project' || words[0] === 'agent' ? words.slice(0, 2).join(' ') : words[0];
  const spec = COMMANDS[name];
  if (!spec) throw usageError(`Unknown command: ${name}. Run clubhouse help.`);
  const positional = words.slice(name.split(' ').length);
  if (positional.length !== spec.positional.length) {
    throw usageError(`${name} takes ${spec.positional.length === 0 ? 'no arguments' : `<${spec.positional.join('> <')}>`}.`);
  }
  const values = {};
  spec.positional.forEach((key, i) => { values[key] = positional[i]; });
  for (const [flag, value] of flags) {
    const key = spec.values[flag];
    if (!key) {
      const allowed = Object.keys(spec.values);
      throw usageError(`${name} doesn't take ${flag}.${allowed.length ? ` It takes: ${allowed.join(', ')}.` : ''}`);
    }
    values[key] = value;
  }
  if (name.endsWith(' set') && !Object.keys(spec.values).some((flag) => values[spec.values[flag]] !== undefined)) {
    throw usageError(`Nothing to change. Set at least one of: ${Object.keys(spec.values).join(', ')}.`);
  }
  return { command: name, values, options };
}

function baseDir(dev, home) {
  return path.join(home, dev ? '.clubhouse-dev' : '.clubhouse');
}

const NOT_RUNNING = 'Clubhouse isn\'t running. Open it and try again.';

/** The running app's port and token. A missing or broken file means it isn't running. */
function readEndpoint(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'cli-endpoint.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new CliError(EXIT.notRunning, 'not_running', NOT_RUNNING);
    throw new CliError(EXIT.auth, 'token_unreadable', `Can't read the Clubhouse token file (${err.code}).`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(EXIT.notRunning, 'not_running', NOT_RUNNING);
  }
  if (!parsed || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535 || typeof parsed.token !== 'string') {
    throw new CliError(EXIT.notRunning, 'not_running', NOT_RUNNING);
  }
  return parsed;
}

/** One request to the app, on loopback only. */
function request(endpoint, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: endpoint.port,
      method,
      path: route,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        [TOKEN_HEADER]: endpoint.token,
        ...(data !== undefined && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // A port reused by something else after a crash answers, but not like this.
          reject(new CliError(EXIT.notRunning, 'not_running', NOT_RUNNING));
          return;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new CliError(EXIT.failed, 'timeout', 'Clubhouse didn\'t answer in time.'));
    });
    req.on('error', (err) => {
      if (err instanceof CliError) reject(err);
      else if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') reject(new CliError(EXIT.notRunning, 'not_running', NOT_RUNNING));
      else reject(new CliError(EXIT.failed, 'request_failed', `Couldn't reach Clubhouse: ${err.message}`));
    });
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function responseError(status, body) {
  const code = (body && body.error && body.error.code) || 'failed';
  const message = (body && body.error && body.error.message) || `Clubhouse answered ${status}.`;
  if (status === 401) return new CliError(EXIT.auth, code, 'Clubhouse refused the token. Restart Clubhouse and try again.');
  if (status === 404) return new CliError(EXIT.notFound, code, message);
  if (status >= 400 && status < 500) return new CliError(EXIT.refused, code, message);
  return new CliError(EXIT.failed, code, message);
}

/** The image the app should read. The app has its own working directory, so a relative path starts here. */
function absoluteImage(image, cwd) {
  return image ? path.resolve(cwd, image) : image;
}

/** The request for a parsed command. */
function toRequest(parsed, cwd) {
  const { command, values } = parsed;
  if (command === 'projects') return { method: 'GET', route: '/cli/v1/projects' };
  if (command === 'agents') {
    return { method: 'GET', route: `/cli/v1/agents${values.project ? `?project=${encodeURIComponent(values.project)}` : ''}` };
  }
  const { image, ...rest } = values;
  const body = { ...rest, ...(image !== undefined && { imagePath: absoluteImage(image, cwd) }) };
  return { method: 'POST', route: command === 'project set' ? '/cli/v1/projects/update' : '/cli/v1/agents/update', body };
}

function icon(item) {
  return item.emoji || (item.hasImage ? 'image' : '-');
}

/** The human-readable result: one tab-separated row per project or agent. */
function formatResult(result) {
  if (result.projects) {
    return result.projects.map((p) => [p.id, p.displayName || p.name, p.color || '-', icon(p), p.path].join('\t')).join('\n');
  }
  if (result.agents) {
    return result.agents.map((a) => [a.id, a.name, a.color, icon(a), a.projectId].join('\t')).join('\n');
  }
  const item = result.project || result.agent;
  return `Updated ${item.displayName || item.name}: color ${item.color || '-'}, icon ${icon(item)}`;
}

/** Runs the CLI and returns its exit code. `io` is what tests swap out. */
async function run(argv, io) {
  let parsed;
  let json = argv.includes('--json');
  try {
    parsed = parseArgs(argv);
    json = !!parsed.options.json;
    if (parsed.command === 'help') {
      io.stdout(USAGE);
      return EXIT.ok;
    }
    const dev = !!parsed.options.dev || io.env.CLUBHOUSE_CLI_DEV === '1';
    const endpoint = readEndpoint(baseDir(dev, io.home));
    const { method, route, body } = toRequest(parsed, io.cwd);
    const response = await request(endpoint, method, route, body);
    if (response.status !== 200) throw responseError(response.status, response.body);
    io.stdout(`${json ? JSON.stringify(response.body, null, 2) : formatResult(response.body)}\n`);
    return EXIT.ok;
  } catch (err) {
    const exitCode = err instanceof CliError ? err.exitCode : EXIT.failed;
    const code = err instanceof CliError ? err.code : 'failed';
    if (json) io.stdout(`${JSON.stringify({ ok: false, error: { code, message: err.message } }, null, 2)}\n`);
    else io.stderr(`clubhouse: ${err.message}\n`);
    return exitCode;
  }
}

module.exports = { EXIT, parseArgs, toRequest, formatResult, run };

if (require.main === module) {
  run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    home: os.homedir(),
    cwd: process.cwd(),
  }).then((code) => { process.exitCode = code; });
}
