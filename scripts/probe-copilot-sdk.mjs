#!/usr/bin/env node
/**
 * Re-probe @github/copilot-sdk against a Copilot CLI without spending tokens
 * (docs/copilot-sdk-driver.md). It drives one session per feature against a
 * local fake model and prints what the model requests and SDK events showed.
 *
 * macOS only: it re-runs itself under sandbox-exec with outbound network limited
 * to localhost, a throwaway HOME, invalid GitHub tokens, and no write access to
 * the real ~/.copilot or ~/.codex, so no paid request is possible.
 *
 * Install both in a scratch directory first, with scripts off:
 *   npm i --ignore-scripts @github/copilot-sdk@<sdk> @github/copilot@<cli>
 *
 * Usage:
 *   node scripts/probe-copilot-sdk.mjs <scratch>/node_modules/@github/copilot-sdk <path-to-copilot> [cli args...]
 *   (macOS arm64 binary: <scratch>/node_modules/@github/copilot-darwin-arm64/copilot)
 *
 * Exits non-zero if any feature fails. A CLI too old to start is a failed handshake.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);

if (process.argv[2] === '--fake-mcp') runFakeMcp();
else if (!process.env.COPILOT_SDK_PROBE_SANDBOXED) sandboxSelf();
else await main();

/** Re-run this script with no network and a throwaway home. */
function sandboxSelf() {
  if (process.platform !== 'darwin') {
    console.error('This probe only runs on macOS, where sandbox-exec can guarantee no paid request.');
    process.exit(2);
  }
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'copilot-sdk-probe-'));
  const real = os.homedir();
  const profile = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))`
    + `(deny file-write* (subpath "${real}/.copilot") (subpath "${real}/.codex"))`;
  const invalid = 'invalid-probe-token';
  const { status } = spawnSync('sandbox-exec', ['-p', profile, process.execPath, self, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: home,
    env: {
      ...process.env,
      COPILOT_SDK_PROBE_SANDBOXED: '1',
      HOME: home,
      COPILOT_HOME: path.join(home, '.copilot'),
      COPILOT_GITHUB_TOKEN: invalid,
      GH_TOKEN: invalid,
      GITHUB_TOKEN: invalid,
    },
  });
  // The CLI can still be flushing logs; a leftover temp directory is harmless.
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
  process.exit(status ?? 1);
}

/** stdio MCP server: `flip` adds the tool `beta` and sends tools/list_changed; `elicit` asks the client. */
function runFakeMcp() {
  const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
  let flipped = false;
  let pendingElicit;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.id === 999 && !m.method) return pendingElicit?.(m.result);
    if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '1' } });
    if (m.method === 'tools/list') return reply({ tools: [tool('flip'), tool('elicit'), ...(flipped ? [tool('beta')] : [])] });
    if (m.method === 'tools/call' && m.params.name === 'flip') {
      flipped = true;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return reply({ content: [{ type: 'text', text: 'flipped' }] });
    }
    if (m.method === 'tools/call' && m.params.name === 'elicit') {
      pendingElicit = (r) => reply({ content: [{ type: 'text', text: JSON.stringify(r) }] });
      return send({ jsonrpc: '2.0', id: 999, method: 'elicitation/create', params: { message: 'Pick', requestedSchema: { type: 'object', properties: { c: { type: 'string' } } } } });
    }
    if (m.id !== undefined) reply({});
  });
}

/** OpenAI-compatible model. Requests that offer tools take the next scripted step. */
async function startFakeModel() {
  const requests = [];
  const queue = [];
  const held = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : {};
      if (!req.url.includes('chat/completions')) { res.statusCode = 404; res.end('{}'); return; }
      const rec = { model: json.model, effort: json.reasoning_effort, tools: (json.tools ?? []).map((t) => t.function?.name), text: JSON.stringify(json.messages ?? '') };
      requests.push(rec);
      let step = rec.tools.length ? queue.shift() ?? {} : {};
      if (typeof step === 'function') step = step(rec);
      if (step.hold) await new Promise((r) => held.add(r));
      const calls = (step.tools ?? []).map((t, index) => ({ index, id: `call_${requests.length}_${index}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }));
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const base = { id: `c${requests.length}`, created: 1, model: json.model };
      const text = step.text ?? (calls.length ? '' : 'ok');
      if (!json.stream) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ...base, object: 'chat.completion', usage, choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: text || null, ...(calls.length && { tool_calls: calls }) } }] }));
        return;
      }
      const chunk = (delta, finish) => `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish && { usage }) })}\n\n`;
      res.setHeader('content-type', 'text/event-stream');
      if (text) res.write(chunk({ role: 'assistant', content: text }, null));
      if (calls.length) res.write(chunk({ role: 'assistant', tool_calls: calls }, null));
      res.write(chunk({}, calls.length ? 'tool_calls' : 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    script: (...steps) => queue.push(...steps),
    release: () => { for (const r of held) r(); held.clear(); },
    reset: () => { requests.length = 0; queue.length = 0; },
    close: () => server.close(),
  };
}

async function main() {
  const [sdkDir, cli, ...cliArgs] = process.argv.slice(2);
  if (!sdkDir || !cli) {
    console.error('Usage: node scripts/probe-copilot-sdk.mjs <sdk package dir> <copilot binary> [cli args...]');
    process.exit(2);
  }
  const { CopilotClient, RuntimeConnection, approveAll } = await import(pathToFileURL(path.join(path.resolve(sdkDir), 'dist/index.js')).href);
  const fake = await startFakeModel();
  const provider = { type: 'openai', baseUrl: fake.baseUrl, apiKey: 'fake' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms && !fn()) await sleep(50); return fn(); };
  const toolRequests = () => fake.requests.filter((r) => r.tools.length);
  const newClient = () => new CopilotClient({ connection: RuntimeConnection.forStdio({ path: cli, args: cliArgs, env: { ...process.env } }), useLoggedInUser: false, logLevel: 'error' });
  // Plain send plus session.idle, as a driver would; sendAndWait hangs on CLIs up to 1.0.82.
  const turn = async (session, prompt) => {
    const done = new Promise((res, rej) => { const off = session.on((e) => { if (e.type === 'session.idle') { off(); res(); } else if (e.type === 'session.error') { off(); rej(new Error(e.data.message)); } }); });
    await session.send({ prompt });
    await within(done, 30000, 'turn');
  };
  const withSession = async (config, fn) => {
    const client = newClient();
    await within(client.start(), 30000, 'start');
    const events = [];
    const session = await within(client.createSession({ model: 'fake-model', provider, onPermissionRequest: approveAll, onEvent: (e) => events.push(e), ...config }), 30000, 'createSession');
    try { return await fn(session, events); } finally {
      await within(session.disconnect(), 5000, 'disconnect').catch(() => {});
      await within(client.stop(), 5000, 'stop').catch(() => client.forceStop());
    }
  };
  const count = (events, type) => events.filter((e) => e.type === type).length;

  const probes = {
    handshake: async () => {
      const client = newClient();
      const t = Date.now();
      await within(client.start(), 30000, 'start');
      const status = await client.getStatus();
      const auth = await client.getAuthStatus();
      await client.stop();
      return { pass: fake.requests.length === 0, version: status.version, protocol: status.protocolVersion, authenticated: auth.isAuthenticated, ms: Date.now() - t };
    },
    steer: () => withSession({}, async (session, events) => {
      fake.script({ hold: true, tools: [{ name: 'no_such_tool' }] }, { text: 'after' });
      const idle = new Promise((r) => session.on('session.idle', r));
      await session.send({ prompt: 'ORIGINAL' });
      await until(() => toolRequests().length >= 1);
      await session.send({ prompt: 'STEERTEXT', mode: 'immediate' });
      await sleep(300);
      fake.release();
      await within(idle, 30000, 'idle');
      return { pass: toolRequests().at(-1).text.includes('STEERTEXT') && count(events, 'session.idle') === 1, modelCalls: toolRequests().length };
    }),
    queue: () => withSession({}, async (session) => {
      fake.script({ hold: true, text: 'one' }, { text: 'two' });
      await session.send({ prompt: 'FIRST' });
      await until(() => toolRequests().length >= 1);
      await session.send({ prompt: 'QUEUED', mode: 'enqueue' });
      await sleep(300);
      const pending = await session.rpc.queue.pendingItems().then((q) => q.items.length).catch((e) => e.message);
      fake.release();
      await until(() => toolRequests().length >= 2);
      return { pass: pending === 1 && toolRequests()[1]?.text.includes('QUEUED'), pending };
    }),
    permission: async () => {
      const seen = [];
      return withSession({ onPermissionRequest: (r) => { seen.push(r.kind); return { kind: 'reject', feedback: 'no' }; } }, async (session) => {
        fake.script({ tools: [{ name: 'bash', args: { command: 'true', description: 'x', mode: 'sync', initial_wait: 5 } }] }, { text: 'ok' });
        await turn(session, 'PERM');
        return { pass: seen.includes('shell'), seen };
      });
    },
    planApproval: async () => {
      const seen = [];
      return withSession({ onExitPlanModeRequest: (r) => { seen.push(r.actions); return { approved: true, selectedAction: r.recommendedAction }; } }, async (session) => {
        await session.rpc.mode.set({ mode: 'plan' });
        fake.script({ tools: [{ name: 'exit_plan_mode', args: { summary: 'Plan', actions: ['interactive'], recommendedAction: 'interactive' } }] }, { text: 'ok' });
        await turn(session, 'PLAN');
        const { mode } = await session.rpc.mode.get().then((m) => (typeof m === 'string' ? { mode: m } : m));
        return { pass: seen.length === 1 && mode === 'interactive', actions: seen[0], modeAfter: mode };
      });
    },
    question: async () => {
      const seen = [];
      return withSession({ onUserInputRequest: (r) => { seen.push(r.question); return { answer: 'blue', wasFreeform: false }; } }, async (session) => {
        fake.script({ tools: [{ name: 'ask_user', args: { question: 'Colour?', choices: ['blue'] } }] }, { text: 'ok' });
        await turn(session, 'QUESTION');
        return { pass: seen.length === 1 };
      });
    },
    subagent: () => withSession({}, async (session, events) => {
      fake.script({ tools: [{ name: 'task', args: { description: 'look', prompt: 'SUB', agent_type: 'explore', name: 'scout' } }] }, { text: 'sub result' }, { text: 'done' });
      await turn(session, 'SUBAGENT');
      return { pass: count(events, 'subagent.started') === 1 && count(events, 'subagent.completed') === 1 };
    }),
    setModelEffort: () => withSession({}, async (session) => {
      await session.setModel('fake-model-2', { reasoningEffort: 'high' });
      fake.script({ text: 'ok' });
      await turn(session, 'MODEL');
      const last = toolRequests().at(-1);
      return { pass: last.model === 'fake-model-2' && last.effort === 'high', model: last.model, effort: last.effort };
    }),
    resume: async () => {
      const first = newClient();
      await first.start();
      const before = await first.createSession({ model: 'fake-model', provider, onPermissionRequest: approveAll });
      const id = before.sessionId;
      fake.script({ text: 'answer' });
      await turn(before, 'HISTORY');
      await before.disconnect();
      await first.stop();
      const second = newClient();
      await second.start();
      const live = [];
      const t = Date.now();
      const after = await within(second.resumeSession(id, { model: 'fake-model', provider, onPermissionRequest: approveAll, onEvent: (e) => live.push(e.type) }), 30000, 'resume');
      const ms = Date.now() - t;
      await sleep(500);
      const replayed = live.filter((t) => t === 'user.message' || t === 'assistant.message').length;
      const liveEvents = live.length;
      fake.script({ text: 'again' });
      await turn(after, 'NEXT');
      const missing = await within(second.resumeSession('00000000-0000-4000-8000-000000000000', { provider, model: 'fake-model', onPermissionRequest: approveAll }), 20000, 'missing').then(() => 'resolved').catch((e) => e.message);
      await after.disconnect();
      await second.stop();
      return { pass: toolRequests().at(-1).text.includes('HISTORY') && replayed === 0 && /not found/i.test(missing), ms, liveEvents, replayed };
    },
    mcp: async () => {
      const elicited = [];
      const config = { onElicitationRequest: (c) => { elicited.push(c.message); return { action: 'accept', content: { c: 'x' } }; }, mcpServers: { fake: { type: 'stdio', command: process.execPath, args: [self, '--fake-mcp'], tools: ['*'] } } };
      return withSession(config, async (session) => {
        await sleep(1500);
        fake.script((r) => ({ tools: [{ name: r.tools.find((t) => t.endsWith('flip')) }] }), { text: 'ok' });
        await turn(session, 'FLIP');
        await sleep(1000);
        let refreshed = false;
        fake.script((r) => { refreshed = r.tools.some((t) => t.endsWith('beta')); return { text: 'ok' }; });
        await turn(session, 'NEXT');
        fake.script((r) => ({ tools: [{ name: r.tools.find((t) => t.endsWith('elicit')) }] }), { text: 'ok' });
        await turn(session, 'ELICIT');
        return { pass: refreshed && elicited.length === 1, stdioLoaded: true, listChangedRefreshed: refreshed, elicited: elicited.length };
      });
    },
  };

  let failed = false;
  for (const [name, probe] of Object.entries(probes)) {
    fake.reset();
    let result;
    try { result = await within(probe(), 90000, name); } catch (err) { result = { pass: false, error: err.message.slice(0, 200) }; }
    fake.release();
    failed ||= !result.pass;
    console.log(`${result.pass ? 'pass' : 'FAIL'} ${name} ${JSON.stringify({ ...result, pass: undefined })}`);
    if (name === 'handshake' && !result.pass) break;
  }
  fake.close();
  process.exit(failed ? 1 : 0);
}
