import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as http from 'http';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(__dirname, 'clubhouse-cli.js');
const { EXIT, parseArgs, run, toRequest } = createRequire(__filename)(SCRIPT);

describe('parseArgs', () => {
  it.each([[[]], [['help']], [['--help']], [['projects', '-h']]])('shows help for %j', (argv) => {
    expect(parseArgs(argv).command).toBe('help');
  });

  it('reads each command', () => {
    expect(parseArgs(['projects'])).toMatchObject({ command: 'projects', values: {} });
    expect(parseArgs(['agents', '--project', 'My App'])).toMatchObject({ command: 'agents', values: { project: 'My App' } });
    expect(parseArgs(['project', 'set', 'p1', '--display-name', 'Shiny', '--color=rose', '--emoji', '🚀', '--image', 'i.png'])).toMatchObject({
      command: 'project set',
      values: { project: 'p1', displayName: 'Shiny', color: 'rose', emoji: '🚀', image: 'i.png' },
    });
    expect(parseArgs(['agent', 'set', 'a1', '--color', 'teal'])).toMatchObject({ command: 'agent set', values: { agentId: 'a1', color: 'teal' } });
  });

  it('takes global flags anywhere', () => {
    expect(parseArgs(['--json', 'projects', '--dev']).options).toEqual({ json: true, dev: true });
  });

  it('takes an empty value, which clears a setting', () => {
    expect(parseArgs(['agent', 'set', 'a1', '--emoji', '']).values.emoji).toBe('');
    expect(parseArgs(['project', 'set', 'p1', '--image=']).values.image).toBe('');
  });

  it.each([
    [['nope'], 'Unknown command'],
    [['project'], 'Unknown command'],
    [['agent', 'rename', 'a1'], 'Unknown command'],
    [['projects', 'extra'], 'no arguments'],
    [['project', 'set', '--color', 'rose'], '<project>'],
    [['agent', 'set', 'a1', 'a2', '--color', 'rose'], '<agentId>'],
    [['agent', 'set', 'a1'], 'Nothing to change'],
    [['project', 'set', 'p1', '--color'], 'needs a value'],
    [['project', 'set', 'p1', '--color', '--emoji', 'x'], 'needs a value'],
    [['agent', 'set', 'a1', '--name', 'renamed'], 'doesn\'t take --name'],
    [['agent', 'set', 'a1', '--display-name', 'x'], 'doesn\'t take --display-name'],
    [['project', 'set', 'p1', '--name', 'x'], 'doesn\'t take --name'],
    [['agent', 'set', 'a1', '--model', 'opus'], 'doesn\'t take --model'],
    [['projects', '--color', 'rose'], 'doesn\'t take --color'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
    try { parseArgs(argv); } catch (err) { expect((err as { exitCode: number }).exitCode).toBe(EXIT.usage); }
  });
});

describe('toRequest', () => {
  const cwd = path.resolve(path.sep, 'work', 'dir');

  it('sends a relative image as absolute, from the CLI\'s working directory', () => {
    const { body } = toRequest(parseArgs(['agent', 'set', 'a1', '--image', path.join('art', 'i.png')]), cwd);
    expect(body).toEqual({ agentId: 'a1', imagePath: path.join(cwd, 'art', 'i.png') });
  });

  it('leaves an absolute image, and an empty one that clears it, alone', () => {
    const absolute = path.resolve(path.sep, 'elsewhere', 'i.png');
    expect(toRequest(parseArgs(['agent', 'set', 'a1', '--image', absolute]), cwd).body.imagePath).toBe(absolute);
    expect(toRequest(parseArgs(['agent', 'set', 'a1', '--image', '']), cwd).body.imagePath).toBe('');
  });

  it('escapes a project in the query', () => {
    expect(toRequest(parseArgs(['agents', '--project', 'a&b c']), cwd).route).toBe('/cli/v1/agents?project=a%26b%20c');
  });

  it('routes updates', () => {
    expect(toRequest(parseArgs(['project', 'set', 'p1', '--color', 'rose']), cwd)).toEqual({
      method: 'POST', route: '/cli/v1/projects/update', body: { project: 'p1', color: 'rose' },
    });
  });
});

describe('run', () => {
  let home: string;
  let server: http.Server | null;
  let seen: Array<{ method?: string; url?: string; token?: string; body: string }>;
  let reply: { status: number; body: string };
  let out: string;
  let err: string;

  const io = (env: Record<string, string> = {}) => ({
    stdout: (text: string) => { out += text; },
    stderr: (text: string) => { err += text; },
    env, home, cwd: home,
  });

  async function startApp(dirName = '.clubhouse'): Promise<number> {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, token: req.headers['x-clubhouse-cli-token'] as string, body });
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await writeEndpoint(dirName, JSON.stringify({ port, token: 'the-token' }));
    return port;
  }

  async function writeEndpoint(dirName: string, content: string): Promise<void> {
    await fsp.mkdir(path.join(home, dirName), { recursive: true });
    await fsp.writeFile(path.join(home, dirName, 'cli-endpoint.json'), content);
  }

  const ok = (extra: object) => ({ status: 200, body: JSON.stringify({ ok: true, ...extra }) });
  const refused = (status: number, code: string, message: string) => ({ status, body: JSON.stringify({ ok: false, error: { code, message } }) });

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-cli-'));
    server = null;
    seen = [];
    out = '';
    err = '';
    reply = ok({ projects: [] });
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('prints usage for help, with no app needed', async () => {
    expect(await run(['help'], io())).toBe(EXIT.ok);
    expect(out).toContain('Exit codes:');
  });

  it('exits with the usage code, and JSON when asked', async () => {
    expect(await run(['nope'], io())).toBe(EXIT.usage);
    expect(err).toContain('Unknown command');
    out = '';
    expect(await run(['nope', '--json'], io())).toBe(EXIT.usage);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: 'usage' } });
  });

  it('says the app isn\'t running when there is no endpoint file, and never makes one', async () => {
    expect(await run(['projects'], io())).toBe(EXIT.notRunning);
    expect(err).toContain('isn\'t running');
    expect(await fsp.readdir(home)).toEqual([]);
  });

  it('reports a stale endpoint file the same way', async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    await writeEndpoint('.clubhouse', JSON.stringify({ port: closedPort, token: 't' }));
    expect(await run(['projects', '--json'], io())).toBe(EXIT.notRunning);
    expect(JSON.parse(out).error.code).toBe('not_running');
  });

  it.each([['not json'], ['{"token":"t"}'], ['{"port":0,"token":"t"}'], ['{"port":"1234","token":"t"}'], ['{"port":1234}'], ['null']])(
    'treats a broken endpoint file (%s) as not running', async (content) => {
      await writeEndpoint('.clubhouse', content);
      expect(await run(['projects'], io())).toBe(EXIT.notRunning);
    });

  it('sends the token and prints rows', async () => {
    await startApp();
    reply = ok({ projects: [{ id: 'p1', name: 'one', displayName: 'Shiny', color: 'rose', emoji: null, hasImage: true, path: '/one' }] });
    expect(await run(['projects'], io())).toBe(EXIT.ok);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/cli/v1/projects', token: 'the-token' });
    expect(out).toBe('p1\tShiny\trose\timage\t/one\n');
  });

  it('prints what the app sent with --json', async () => {
    await startApp();
    reply = ok({ agents: [{ id: 'a1' }] });
    expect(await run(['agents', '--json'], io())).toBe(EXIT.ok);
    expect(JSON.parse(out)).toEqual({ ok: true, agents: [{ id: 'a1' }] });
  });

  it('posts a change and reports it', async () => {
    await startApp();
    reply = ok({ agent: { id: 'a1', name: 'fox', color: 'teal', emoji: '🦊', hasImage: false } });
    expect(await run(['agent', 'set', 'a1', '--color', 'teal', '--emoji', '🦊'], io())).toBe(EXIT.ok);
    expect(JSON.parse(seen[0].body)).toEqual({ agentId: 'a1', color: 'teal', emoji: '🦊' });
    expect(out).toContain('Updated fox: color teal, icon 🦊');
  });

  it('uses the dev base dir with --dev or the env var, and prod by default', async () => {
    await startApp('.clubhouse-dev');
    expect(await run(['projects'], io())).toBe(EXIT.notRunning);
    expect(await run(['projects', '--dev'], io())).toBe(EXIT.ok);
    expect(await run(['projects'], io({ CLUBHOUSE_CLI_DEV: '1' }))).toBe(EXIT.ok);
  });

  it.each([
    [refused(400, 'invalid_color', 'Not a color.'), EXIT.refused],
    [refused(409, 'dispatcher_locked', 'Locked.'), EXIT.refused],
    [refused(404, 'not_found', 'No such agent.'), EXIT.notFound],
    [refused(500, 'internal', 'Disk full.'), EXIT.failed],
  ])('maps %j to its exit code and shows the app\'s message', async (response, code) => {
    await startApp();
    reply = response;
    expect(await run(['agent', 'set', 'a1', '--color', 'x'], io())).toBe(code);
    expect(err).toContain(JSON.parse(response.body).error.message);
  });

  it('asks for a restart when the token is refused', async () => {
    await startApp();
    reply = refused(401, 'bad_token', 'Out of date.');
    expect(await run(['projects'], io())).toBe(EXIT.auth);
    expect(err).toContain('Restart Clubhouse');
  });

  it('treats something else answering on the port as the app not running', async () => {
    await startApp();
    reply = { status: 200, body: '<html>' };
    expect(await run(['projects'], io())).toBe(EXIT.notRunning);
  });

  it('runs as a script with the right exit code', async () => {
    const child = spawn(process.execPath, [SCRIPT, 'projects'], { env: { ...process.env, HOME: home, USERPROFILE: home, CLUBHOUSE_CLI_DEV: '' } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(code).toBe(EXIT.notRunning);
    expect(stderr).toContain('isn\'t running');
  });
});
