// Shared helpers for chat protocol fixtures: the JSONL format, client-line
// matching, id remapping and redaction. Used by fake-cli.mjs (replay) and
// record.mjs (capture). See docs/chat-fixtures.md for the format.

import { readFile } from 'node:fs/promises';

export const FIXTURE_FORMAT = 'clubhouse-chat-fixture';
export const FIXTURE_VERSION = 1;

/** Wire protocols a fixture can hold. */
export const PROTOCOLS = ['claude-stream-json', 'codex-app-server', 'acp', 'copilot-sdk'];

/** Drivers reach this protocol over TCP, not stdio: `--headless --port 0`, then `Content-Length` frames. */
export const TCP_PROTOCOLS = ['copilot-sdk'];

/** The line a headless Copilot prints once it accepts connections. Launchers read the port from it. */
export const LISTENING_RE = /listening on port (\d+)/i;

/** Stands in for the per-launch connection token in a recording. */
export const REDACTED_CONNECTION_TOKEN = 'REDACTED_CONNECTION_TOKEN';

/**
 * Parse fixture text. Returns `{ header, entries }` where entries are the
 * replayable `from: 'client' | 'cli'` lines in order (notes are dropped).
 */
export function parseFixture(text, source = 'fixture') {
  const lines = text.split(/\r?\n/);
  let header = null;
  const entries = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch (err) {
      throw new Error(`${source}:${index + 1}: invalid JSON (${err.message})`);
    }
    if (value.kind === 'header') {
      if (header) throw new Error(`${source}:${index + 1}: duplicate header`);
      header = value;
      return;
    }
    if (value.kind === 'note') return;
    if (value.from !== 'client' && value.from !== 'cli') {
      throw new Error(`${source}:${index + 1}: entry needs "from": "client" or "cli"`);
    }
    const payloads = ['msg', 'raw', 'stderr', 'exit'].filter((k) => k in value);
    if (payloads.length !== 1) {
      throw new Error(`${source}:${index + 1}: entry needs exactly one of msg, raw, stderr, exit`);
    }
    if (value.from === 'client' && !('msg' in value)) {
      throw new Error(`${source}:${index + 1}: client entries must carry "msg"`);
    }
    entries.push({ ...value, line: index + 1 });
  });
  if (!header) throw new Error(`${source}: missing header line`);
  if (header.format !== FIXTURE_FORMAT) {
    throw new Error(`${source}: header.format must be "${FIXTURE_FORMAT}"`);
  }
  if (header.version !== FIXTURE_VERSION) {
    throw new Error(`${source}: unsupported fixture version ${header.version}`);
  }
  if (!PROTOCOLS.includes(header.protocol)) {
    throw new Error(`${source}: unknown protocol "${header.protocol}"`);
  }
  return { header, entries };
}

export async function loadFixture(path) {
  return parseFixture(await readFile(path, 'utf8'), path);
}

/** Serialize a header plus entries back to JSONL. */
export function serializeFixture(header, entries) {
  const out = [JSON.stringify(header)];
  for (const entry of entries) {
    const { line: _line, ...rest } = entry;
    out.push(JSON.stringify(rest));
  }
  return out.join('\n') + '\n';
}

/**
 * The protocol-level identity of a client message, used to match what a
 * driver sends against what the fixture expects. Ids are deliberately left
 * out: drivers number their own requests.
 */
export function messageKey(protocol, msg) {
  if (!msg || typeof msg !== 'object') return 'non-object';
  if (protocol === 'claude-stream-json') {
    if (msg.type === 'control_request') return `control_request:${msg.request?.subtype}`;
    if (msg.type === 'control_response') return `control_response:${msg.response?.subtype}`;
    return String(msg.type);
  }
  if (typeof msg.method === 'string') {
    return 'id' in msg ? `request:${msg.method}` : `notification:${msg.method}`;
  }
  if ('id' in msg) return 'error' in msg ? 'response:error' : 'response:result';
  return 'unknown';
}

/** True when every field in `expected` is present and equal in `actual`. Arrays compare element-wise and must match length. */
export function deepSubset(expected, actual) {
  if (expected === actual) return true;
  if (expected === null || typeof expected !== 'object') return false;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, i) => deepSubset(item, actual[i]));
  }
  return Object.keys(expected).every((key) => deepSubset(expected[key], actual[key]));
}

/**
 * Check a client message against a fixture entry. The key must match; when
 * the entry has `match`, that partial object must also be contained.
 * Returns null on success or a human-readable reason.
 */
export function matchClientMessage(protocol, entry, actual) {
  const expectedKey = messageKey(protocol, entry.msg);
  const actualKey = messageKey(protocol, actual);
  if (expectedKey !== actualKey) return `expected ${expectedKey}, got ${actualKey}`;
  if (entry.match !== undefined && !deepSubset(entry.match, actual)) {
    return `${expectedKey} did not contain ${JSON.stringify(entry.match)}`;
  }
  return null;
}

/** The request id a client message introduces, if any (recorded or live). */
export function clientRequestId(protocol, msg) {
  if (protocol === 'claude-stream-json') {
    return msg?.type === 'control_request' ? msg.request_id : undefined;
  }
  return typeof msg?.method === 'string' && 'id' in msg ? msg.id : undefined;
}

/**
 * Rewrite a recorded CLI message so a response answers the id the live
 * driver actually used. `idMap` maps recorded client ids to live ones.
 */
export function remapCliMessage(protocol, msg, idMap) {
  if (!msg || typeof msg !== 'object' || idMap.size === 0) return msg;
  if (protocol === 'claude-stream-json') {
    const response = msg.type === 'control_response' ? msg.response : undefined;
    if (response && idMap.has(response.request_id)) {
      return { ...msg, response: { ...response, request_id: idMap.get(response.request_id) } };
    }
    if (msg.type === 'control_cancel_request' && idMap.has(msg.request_id)) {
      return { ...msg, request_id: idMap.get(msg.request_id) };
    }
    return msg;
  }
  // JSON-RPC: only responses (id, no method) answer a client request.
  if (typeof msg.method !== 'string' && 'id' in msg && idMap.has(msg.id)) {
    return { ...msg, id: idMap.get(msg.id) };
  }
  return msg;
}

/**
 * The session id a client message names (`copilot-sdk`). The client picks these
 * itself, so a replay has to answer with the live one.
 */
export function clientSessionId(protocol, msg) {
  if (protocol !== 'copilot-sdk') return undefined;
  const id = msg?.params?.sessionId;
  return typeof id === 'string' ? id : undefined;
}

/** Put the live session ids in a recorded CLI message. `sessionIds` maps recorded ids to live ones. */
export function remapSessionIds(value, sessionIds) {
  return sessionIds.size === 0 ? value : redactValue(value, [...sessionIds]);
}

/**
 * Key- and identity-shaped strings scrubbed from every recording by default:
 * API keys, GitHub tokens, bearer tokens, JWTs and email addresses (other
 * than the example.com placeholders fixtures use). Replacements avoid the
 * prefixes the committed-fixture guard test rejects.
 */
export const SECRET_REDACTIONS = [
  [/sk-ant-[\w-]{8,}/g, 'REDACTED_ANTHROPIC_KEY'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'REDACTED_API_KEY'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'REDACTED_GITHUB_TOKEN'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'REDACTED_GITHUB_TOKEN'],
  [/\bBearer [A-Za-z0-9._~+/=-]{8,}/g, 'REDACTED_BEARER_TOKEN'],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, 'REDACTED_JWT'],
  [/[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, 'user@example.com'],
];

/**
 * Apply each `[from, to]` pair to every string value, recursively. `from` is
 * either a literal string (every occurrence is replaced) or a global RegExp.
 */
export function redactValue(value, pairs) {
  if (typeof value === 'string') {
    let out = value;
    for (const [from, to] of pairs) {
      if (from instanceof RegExp) out = out.replace(from, to);
      else if (from) out = out.split(from).join(to);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, pairs));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, pairs);
    return out;
  }
  return value;
}

/** Read a dotted path (`params.turn.id`) from an object. */
export function getPath(value, path) {
  let current = value;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Fill `{{name.path}}` placeholders in a script message. A string that is
 * exactly one placeholder takes the referenced value with its type; a
 * placeholder inside a longer string is interpolated as text.
 */
export function fillTemplate(value, scope) {
  if (typeof value === 'string') {
    const whole = /^\{\{([\w.-]+)\}\}$/.exec(value);
    if (whole) return getPath(scope, whole[1]);
    return value.replace(/\{\{([\w.-]+)\}\}/g, (_m, path) => String(getPath(scope, path) ?? ''));
  }
  if (Array.isArray(value)) return value.map((item) => fillTemplate(item, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = fillTemplate(item, scope);
    return out;
  }
  return value;
}

/**
 * Split a growing stdout buffer into complete lines. Returns the lines and
 * the unfinished remainder.
 */
export function splitLines(buffer) {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim()), rest };
}

/** One message as a `Content-Length` frame. The length counts bytes, not characters. */
export function encodeFrame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Take the complete `Content-Length` frames off a growing buffer. Returns their
 * bodies as text and the unfinished remainder. A header with no length throws,
 * since nothing after it can be found.
 */
export function splitFrames(buffer) {
  const bodies = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    if (end === -1) return { bodies, rest };
    const header = rest.subarray(0, end).toString('ascii');
    const length = /^content-length:\s*(\d+)\s*$/im.exec(header)?.[1];
    if (length === undefined) throw new Error(`frame header has no Content-Length: ${header.slice(0, 200)}`);
    const start = end + 4;
    if (rest.length < start + Number(length)) return { bodies, rest };
    bodies.push(rest.subarray(start, start + Number(length)).toString('utf8'));
    rest = rest.subarray(start + Number(length));
  }
}
