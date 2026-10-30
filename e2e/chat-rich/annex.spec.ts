import { test, expect } from '@playwright/test';
import * as https from 'https';
import * as path from 'path';
import { CHAT_MEDIA, md } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { enableAnnexViaPreload, getAnnexStatus, pairViaHttp } from '../annex-v2/helpers';
import { generateTestIdentity, type TestIdentity } from '../annex-v2/tls-test-utils';
import { chatDom, openRichChat, setExperimentalFlags, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Rich content over Annex (#2480 area 8). A Claude chat on the satellite names
 * files inside and outside its project; a controller reads the chat snapshot
 * and fetches previews through the mobile API. The desktop controller has no
 * chat view yet (remote chat agents show as a terminal or placeholder,
 * #2390/#2391), so the controller here is a phone-style client: an mTLS
 * identity from the annex-v2 helpers, paired over TLS with a client
 * certificate. One satellite launch serves every test.
 */

test.describe.configure({ mode: 'serial' });

interface Reply { status: number; body: Record<string, unknown> }

/** A JSON request to the satellite's TLS port, presenting the identity's client certificate. */
function mtlsJson(port: number, identity: TestIdentity, method: 'GET' | 'POST', urlPath: string, body?: unknown): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, method, path: urlPath,
      cert: identity.certPem, key: identity.keyPem, rejectUnauthorized: false, agent: false,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch { reject(new Error(`${method} ${urlPath}: not JSON (${res.statusCode}): ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Windows paths compare without regard to case. */
const samePath = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

let session: RichChat;
let controller: TestIdentity;
let port: number;
let pdfPath: string;

const snapshot = () => mtlsJson(port, controller, 'GET', `/api/v1/mobile/agents/${encodeURIComponent(session.agentId)}/chat`);
const content = (filePath: string, identity = controller) =>
  mtlsJson(port, identity, 'GET', `/api/v1/mobile/agents/${encodeURIComponent(session.agentId)}/content?path=${encodeURIComponent(filePath)}`);

test.beforeAll(async () => {
  session = await openRichChat({
    cli: 'claude',
    projectFiles: { 'notes.md': '# Notes\n\nInside the project.\n' },
    outsideFiles: { 'report.pdf': { copy: CHAT_MEDIA.pdf }, 'outside.txt': 'Outside the project.\n' },
    script: ({ outsideDir }) => {
      pdfPath = path.join(outsideDir, 'report.pdf');
      return {
        description: 'a reply naming files inside and outside the project',
        turns: [{ steps: [{ type: 'text', text: `The report is ${md.path(pdfPath)} and the notes are ${md.path('notes.md')}.` }] }],
      };
    },
  });
  const dom = chatDom(session.window);
  await session.send('Where are the report and the notes?');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
  await session.expectScriptComplete();

  await enableAnnexViaPreload(session.window);
  const status = await getAnnexStatus(session.window);
  expect(status.advertising, 'the satellite Annex server did not start').toBe(true);
  port = status.port;

  // Paired over TLS with a client certificate: the server pins it and treats the peer as a phone controller.
  controller = generateTestIdentity();
  const paired = await mtlsJson(port, controller, 'POST', '/pair', { pin: status.pin, publicKey: controller.ed25519PublicKeyBase64 });
  expect(paired.status).toBe(200);
  expect(paired.body).toMatchObject({ mobileProtocolVersion: 1, pairingMode: 'persistent' });
});

test.afterAll(async () => {
  await session?.close();
});

test('claude: the satellite chat snapshot carries contentAnyPath and the agent folders', async () => {
  const { status, body } = await snapshot();
  expect(status).toBe(200);
  expect(body).toMatchObject({ agentId: session.agentId, readOnly: false, contentAnyPath: true });
  expect((body.contentRoots as string[]).map(samePath)).toContain(samePath(session.projectDir));
  // The reply that names the files reached the controller as written.
  expect(JSON.stringify(body.events)).toContain(JSON.stringify(pdfPath).slice(1, -1));
});

test('claude: a controller previews a PDF outside the project as the pdf kind', async () => {
  const { status, body } = await content(pdfPath);
  expect(status).toBe(200);
  expect(body).toMatchObject({ kind: 'pdf', name: 'report.pdf', mimeType: 'application/pdf' });
  expect(body).not.toHaveProperty('tooLarge');
  const bytes = Buffer.from(body.base64 as string, 'base64');
  expect(bytes.byteLength).toBe(body.size);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('claude: a controller previews text outside the project and a relative path inside it', async () => {
  const outside = await content(path.join(session.outsideDir, 'outside.txt'));
  expect(outside.status).toBe(200);
  expect(outside.body).toMatchObject({ kind: 'text', name: 'outside.txt', text: 'Outside the project.\n', truncated: false });

  // A relative path resolves against the agent's first folder.
  const relative = await content('notes.md');
  expect(relative.status).toBe(200);
  expect(relative.body).toMatchObject({ kind: 'text', name: 'notes.md', text: '# Notes\n\nInside the project.\n' });
});

test('claude: a missing file, and a controller without a pinned certificate, get no content', async () => {
  const missing = await content(path.join(session.outsideDir, 'missing.pdf'));
  expect(missing).toEqual({ status: 404, body: { error: 'content_unavailable' } });

  // A desktop-style controller pairs on the plain pairing port, so its certificate isn't pinned.
  const status = await getAnnexStatus(session.window);
  const desktop = generateTestIdentity();
  await pairViaHttp('127.0.0.1', status.pairingPort, status.pin, desktop.ed25519PublicKeyBase64);
  expect(await content(pdfPath, desktop)).toEqual({ status: 403, body: { error: 'client_certificate_required' } });
});

test('claude: with rich content off, the snapshot drops contentAnyPath and previews stop', async () => {
  await setExperimentalFlags(session.window, { richChatContent: false });
  const { status, body } = await snapshot();
  expect(status).toBe(200);
  expect(body).toMatchObject({ contentAnyPath: false, contentRoots: [] });
  expect(await content(pdfPath)).toEqual({ status: 404, body: { error: 'content_unavailable' } });
});
