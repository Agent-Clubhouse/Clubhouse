/**
 * The clubhouse CLI's endpoint (#2598): display settings for programs outside
 * the app, on the always-running hook server, so it adds no port and works
 * with MCP off. That server only listens on 127.0.0.1.
 *
 * The CLI finds it through a user-only file under the Clubhouse base dir,
 * holding the port and a token made fresh at each start. Agent nonces play no
 * part. A browser page can reach loopback too, so a request with an Origin or
 * another Host is refused along with a bad token.
 *
 * All of it goes through appearance-service with the `all` scope. Anything
 * able to read the token file runs as this user and could edit the config
 * files anyway, so the token adds no privilege, only a safer way in.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { getBaseDirPath } from './base-dir';
import { appLog } from './log-service';

export const CLI_ROUTE_PREFIX = '/cli/';
export const CLI_TOKEN_HEADER = 'x-clubhouse-cli-token';
const ENDPOINT_FILE = 'cli-endpoint.json';
const MAX_BODY_BYTES = 64 * 1024;

const PROJECT_FIELDS = ['project', 'displayName', 'color', 'emoji', 'imagePath'] as const;
const AGENT_FIELDS = ['agentId', 'color', 'emoji', 'imagePath'] as const;

let token: string | null = null;
let port = 0;

function endpointFilePath(): string {
  return path.join(getBaseDirPath(), ENDPOINT_FILE);
}

/** Make a new token and write it, with the port, for the CLI to find. Readable by this user only. */
export async function publishCliEndpoint(listeningPort: number): Promise<void> {
  const nextToken = randomBytes(32).toString('hex');
  const file = endpointFilePath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify({ port: listeningPort, token: nextToken }), { mode: 0o600 });
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  token = nextToken;
  port = listeningPort;
}

/** Stop answering and remove the file, so the CLI can say at once that the app isn't running. */
export function unpublishCliEndpoint(): void {
  if (!token) return;
  token = null;
  port = 0;
  try {
    fs.rmSync(endpointFilePath(), { force: true });
  } catch (err) {
    // telemetry-exempt: logged; a file left behind just points at a closed port, which the CLI reports the same way
    appLog('core:cli', 'warn', 'Could not remove the CLI endpoint file', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function refuse(res: http.ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { ok: false, error: { code, message } });
}

function tokenMatches(received: unknown): boolean {
  if (!token || typeof received !== 'string') return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Host a local client sends. Anything else is a page that resolved its own name to loopback. */
function hostAllowed(host: string | undefined): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

class BadRequest extends Error {}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('The request is too large.');
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // telemetry-exempt: the caller gets this as a 400
    throw new BadRequest('The request isn\'t valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequest('The request must be a JSON object.');
  return parsed as Record<string, unknown>;
}

/** The named string fields of a request. A setting this endpoint doesn't change is refused, not ignored. */
function pickFields<K extends string>(body: Record<string, unknown>, allowed: readonly K[]): Partial<Record<K, string>> {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key as K));
  if (unknown.length > 0) throw new BadRequest(`Can't change ${unknown.join(', ')}. This takes only: ${allowed.join(', ')}.`);
  const picked: Partial<Record<K, string>> = {};
  for (const key of allowed) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new BadRequest(`${key} must be a string.`);
    picked[key] = value;
  }
  return picked;
}

const APPEARANCE_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  out_of_scope: 403,
  dispatcher_locked: 409,
  agent_creating: 409,
  ambiguous_project: 409,
};

async function route(req: http.IncomingMessage, url: URL): Promise<unknown | null> {
  // Loaded here: appearance-service reaches agent-system, which imports the hook server hosting this.
  const appearance = await import('./appearance-service');
  const key = `${req.method} ${url.pathname}`;
  switch (key) {
    case 'GET /cli/v1/projects':
      return { projects: await appearance.listProjectAppearances() };
    case 'GET /cli/v1/agents':
      return { agents: await appearance.listAgentAppearances(url.searchParams.get('project') ?? undefined) };
    case 'POST /cli/v1/projects/update': {
      const { project, ...updates } = pickFields(await readJsonBody(req), PROJECT_FIELDS);
      return { project: await appearance.updateProjectAppearance({ scope: 'all' }, project, updates) };
    }
    case 'POST /cli/v1/agents/update': {
      const { agentId, ...updates } = pickFields(await readJsonBody(req), AGENT_FIELDS);
      return { agent: await appearance.updateAgentAppearance({ scope: 'all' }, agentId, updates) };
    }
    default:
      return null;
  }
}

export async function handleCliRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Before anything else: nothing is read, and nothing says what exists, without the token.
  if (req.headers.origin !== undefined || !hostAllowed(req.headers.host)) {
    appLog('core:cli', 'warn', 'Refused a CLI request from a browser or an unexpected host');
    refuse(res, 403, 'forbidden', 'This endpoint is only for the clubhouse CLI.');
    return;
  }
  if (!tokenMatches(req.headers[CLI_TOKEN_HEADER])) {
    appLog('core:cli', 'warn', 'Refused a CLI request with a bad token');
    refuse(res, 401, 'bad_token', 'The token is missing or out of date.');
    return;
  }
  try {
    const result = await route(req, new URL(req.url ?? '/', 'http://127.0.0.1'));
    if (result === null) {
      refuse(res, 404, 'unknown_route', 'No such request.');
      return;
    }
    send(res, 200, { ok: true, ...(result as object) });
  } catch (err) {
    const { AppearanceError } = await import('./appearance-service');
    if (err instanceof BadRequest) {
      refuse(res, 400, 'invalid_request', err.message);
    } else if (err instanceof AppearanceError) {
      refuse(res, APPEARANCE_STATUS[err.code] ?? 400, err.code, err.message);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      // telemetry-exempt: logged; the caller gets it as a 500
      appLog('core:cli', 'error', 'CLI request failed', { meta: { url: req.url?.split('?')[0], error: message } });
      refuse(res, 500, 'internal', message);
    }
  }
}
