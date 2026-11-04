// PILOT, never ships. Plain headless Chromium over raw CDP: no Playwright, no Electron, a throwaway profile,
// loopback only, with the production CSP from src/main/csp-nonce.ts as a real response header.
// Run: node scripts/pilot/run-chromium.mjs <chrome-headless-shell> <harness dir> [--perf]
/* global WebSocket */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../e2e/feedback-editor-pilot-scenario.mjs';

const [bin, dir] = process.argv.slice(2);
const perf = process.argv.includes('--perf');
const strict = process.argv.includes('--strict');
const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, '../../src/renderer/features/feedback/pilot-vendor/test-support/screenshot-flatten-v1.json'), 'utf8'));
const CSP = "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'nonce-pilot' blob: clubhouse-plugin:; worker-src 'self' blob:";
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.ttf': 'font/ttf' };
const page = '<!doctype html><html class="h-full"><head><meta charset="utf-8"><title>pilot</title></head><body class="h-full"><div id="root"></div><script src="/harness.js"></script></body></html>';
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname;
  if (name === '/') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': CSP }); return res.end(page); }
  try {
    const body = readFileSync(normalize(join(dir, name)));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), 'editor-pilot-profile-'));
const chrome = spawn(bin, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,800', '--force-device-scale-factor=2', '--disable-gpu', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  chrome.stderr.on('data', (d) => { err += d; const m = err.match(/ws:\/\/\S+/); if (m) resolve(m[0]); });
  chrome.on('exit', () => reject(new Error(`chrome exited: ${err}`)));
});
const browser = new WebSocket(wsUrl);
await new Promise((r) => { browser.onopen = r; });
let seq = 0;
const pending = new Map();
const consoleLines = [];
browser.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); }
  if (msg.method === 'Runtime.exceptionThrown') consoleLines.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') consoleLines.push(`log: ${msg.params.entry.text}`);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleLines.push(`console: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
};
const raw = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); browser.send(JSON.stringify({ id, method, params, sessionId })); });
const { targetId } = await raw('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
const cdp = (method, params) => raw(method, params, sessionId);
await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Log.enable');
await cdp('Page.navigate', { url: `${origin}${strict ? '?strict' : ''}` });
for (let i = 0; i < 100; i++) {
  const { result } = await cdp('Runtime.evaluate', { expression: 'Boolean(window.__feedbackEditorPilot)', returnByValue: true });
  if (result.value) break;
  await new Promise((r) => setTimeout(r, 100));
  if (i === 99) throw new Error(`harness never loaded: ${consoleLines.join('\n')}`);
}
const buttonsOf = { left: 1, none: 0 };
let pressed = 'none';
const mouse = async (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: pressed === 'left' || type !== 'mouseMoved' ? 'left' : 'none', buttons: buttonsOf[pressed], clickCount: type === 'mouseMoved' ? 0 : 1 });
const KEYS = { Tab: 9, Escape: 27, Enter: 13 };
const adapter = {
  evaluate: async (fn, arg) => {
    const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  },
  mouse: {
    move: async (x, y) => mouse('mouseMoved', x, y),
    down: async () => { pressed = 'left'; const { x, y } = last; return mouse('mousePressed', x, y); },
    up: async () => { pressed = 'none'; const { x, y } = last; return mouse('mouseReleased', x, y); },
  },
  keyboard: {
    press: async (key) => {
      const [base, ...mods] = key.split('+').reverse();
      const modifiers = mods.includes('Shift') ? 8 : 0;
      const code = KEYS[base] ?? base.toUpperCase().charCodeAt(0);
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: base, code: base, windowsVirtualKeyCode: code, modifiers });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: base, code: base, windowsVirtualKeyCode: code, modifiers });
    },
  },
};
let last = { x: 0, y: 0 };
const move = adapter.mouse.move;
adapter.mouse.move = async (x, y) => { last = { x, y }; return move(x, y); };

let failed = 0;
try {
  const report = await runScenario(adapter, fixture, { perf });
  report.strict = strict;
  report.browserConsoleErrors = consoleLines;
  console.log(JSON.stringify(report, null, 1));
  failed = report.problems.length;
} finally {
  browser.close();
  chrome.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
