/**
 * Content redaction for diag lines (spec §6.12, #2299). Not the export
 * scrubber: paths, error text and raw ids are what makes a diag line useful,
 * so they stay. What goes:
 *
 * - the home directory, replaced by `<home>` (the rest of the path stays);
 * - secrets: values of keys named like a token, secret, password, API key,
 *   authorization or cookie, bearer and basic credentials, URL userinfo, and
 *   well-known token formats, in `msg` and in every `meta` string;
 * - content (#1919): prompts, missions, chat messages, tool and RPC
 *   arguments, spawn args, env values, request and response bodies, replaced
 *   by their size;
 * - size: strings over 2,000 characters and `meta` over 8 KB are cut.
 */
import { DIAG_MAX_META_BYTES, DIAG_MAX_STRING_CHARS } from '../../shared/telemetry/diag';
import { literalPattern } from './scrubber';

export const REDACTED = '<redacted>';
const MAX_DEPTH = 6;
const MAX_KEYS = 64;
const MAX_ITEMS = 64;
const MAX_KEY_CHARS = 128;

export interface DiagRedactor {
  text(input: string): string;
  meta(input: Record<string, unknown>): Record<string, unknown>;
}

/** `apiKey`, `api_key`, `API-Key` all normalize to `apikey`. */
const norm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const SECRET_KEY_PARTS = ['token', 'secret', 'password', 'passwd', 'passphrase', 'apikey', 'authorization', 'cookie', 'credential', 'privatekey', 'accesskey'];
/** Numeric usage counts (`maxTokens`, `inputTokens`) are not secrets; only non-number values are redacted. */
export function isSecretKey(key: string): boolean {
  const k = norm(key);
  return SECRET_KEY_PARTS.some((p) => k.includes(p));
}

const CONTENT_KEYS = new Set([
  'prompt', 'prompts', 'mission', 'instructions', 'messages', 'content', 'contents', 'text', 'body',
  'input', 'inputs', 'toolinput', 'args', 'argv', 'arguments', 'params', 'parameters',
  'env', 'environment', 'response', 'responsebody', 'requestbody', 'completion', 'delta', 'transcript', 'stdin',
]);
/** Keys whose value is prompt or response content (#1919): `prompt`, `systemPrompt`, `args`, `params`, ... */
export function isContentKey(key: string): boolean {
  const k = norm(key);
  return CONTENT_KEYS.has(k) || k.endsWith('prompt') || k.endsWith('prompts');
}

const SECRET_NAME = String.raw`(?:(?:access|refresh|id|auth|session|bearer)[_-]?)?token|(?:client[_-]?)?secret|password|passwd|api[_-]?key|authorization|cookie`;
const SECRET_VALUE_RES: Array<[RegExp, string]> = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // `"apiKey": "x y"`, `token='x'`
  [new RegExp(`(${SECRET_NAME})(["']?\\s*[:=]\\s*)(["'])(?:(?!\\3)[^\\n])*\\3`, 'gi'), `$1$2$3${REDACTED}$3`],
  // `token=x`, `password: x`, `?api_key=x&`
  [new RegExp(`(${SECRET_NAME})(["']?\\s*[:=]\\s*)(?![<"']|(?:bearer|basic)\\s)[^\\s"'&,;}]+`, 'gi'), `$1$2${REDACTED}`],
  // `--api-key x`, `--token x`
  [/(--(?:api[_-]?key|token|password|secret|auth[_-]?token))(\s+|=)(?!<)\S+/gi, `$1$2${REDACTED}`],
  // userinfo in a URL: https://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi, `$1${REDACTED}@`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
];

function cut(s: string, max = DIAG_MAX_STRING_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…[cut]` : s;
}

function sizeOf(value: unknown): string {
  if (typeof value === 'string') return `<redacted: ${value.length} chars>`;
  if (Array.isArray(value)) return `<redacted: ${value.length} items>`;
  if (value && typeof value === 'object') return `<redacted: ${Object.keys(value).length} keys>`;
  return REDACTED;
}

export function createDiagRedactor(ctx: { homeDir?: string } = {}): DiagRedactor {
  const home = ctx.homeDir && ctx.homeDir.length > 1 ? literalPattern(ctx.homeDir, false) : null;

  function text(input: string): string {
    if (!input) return input;
    // Pre-cut with slack so the patterns never run over a huge string, yet a
    // secret near the final cut is still whole when they run.
    let out = input.length > DIAG_MAX_STRING_CHARS * 2 ? input.slice(0, DIAG_MAX_STRING_CHARS * 2) : input;
    if (home) out = out.replace(home, '<home>');
    for (const [re, sub] of SECRET_VALUE_RES) out = out.replace(re, sub);
    return cut(out);
  }

  function value(v: unknown, depth: number, seen: WeakSet<object>): unknown {
    switch (typeof v) {
      case 'string':
        return text(v);
      case 'number':
        return Number.isFinite(v) ? v : String(v);
      case 'boolean':
        return v;
      case 'bigint':
        return v.toString();
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
    }
    if (v === null) return null;
    const o = v as object;
    if (seen.has(o)) return '<circular>';
    if (depth >= MAX_DEPTH) return '<too deep>';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `<binary: ${(v as ArrayBufferLike).byteLength} bytes>`;
    seen.add(o);
    try {
      if (v instanceof Error) {
        const e: Record<string, unknown> = { name: text(String(v.name)), message: text(String(v.message)) };
        const code = (v as { code?: unknown }).code;
        if (typeof code === 'string' || typeof code === 'number') e.code = value(code, depth + 1, seen);
        if (typeof v.stack === 'string') e.stack = text(v.stack);
        return e;
      }
      if (v instanceof Map) return object(Object.fromEntries([...v.entries()].slice(0, MAX_KEYS).map(([k, x]) => [String(k), x])), depth, seen);
      if (v instanceof Set) return array([...v].slice(0, MAX_ITEMS + 1), depth, seen);
      if (Array.isArray(v)) return array(v, depth, seen);
      return object(v as Record<string, unknown>, depth, seen);
    } finally {
      seen.delete(o);
    }
  }

  function array(v: unknown[], depth: number, seen: WeakSet<object>): unknown[] {
    const out = v.slice(0, MAX_ITEMS).map((x) => {
      const r = value(x, depth + 1, seen);
      return r === undefined ? null : r;
    });
    if (v.length > MAX_ITEMS) out.push(`<${v.length - MAX_ITEMS} more items>`);
    return out;
  }

  function object(v: Record<string, unknown>, depth: number, seen: WeakSet<object>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(v);
    } catch {
      return out;
    }
    for (const key of keys.slice(0, MAX_KEYS)) {
      let raw: unknown;
      try {
        raw = v[key];
      } catch {
        continue;
      }
      const k = cut(home ? key.replace(home, '<home>') : key, MAX_KEY_CHARS);
      if (isContentKey(key)) {
        // Env keys are useful (which variables were set); their values never are.
        const n = norm(key);
        out[k] =
          (n === 'env' || n === 'environment') && raw && typeof raw === 'object' && !Array.isArray(raw)
            ? Object.fromEntries(Object.keys(raw).slice(0, MAX_KEYS).map((ek) => [cut(ek, MAX_KEY_CHARS), REDACTED]))
            : sizeOf(raw);
        continue;
      }
      if (isSecretKey(key) && typeof raw !== 'number' && typeof raw !== 'boolean' && raw !== null && raw !== undefined) {
        out[k] = REDACTED;
        continue;
      }
      const r = value(raw, depth + 1, seen);
      if (r !== undefined) out[k] = r;
    }
    if (keys.length > MAX_KEYS) out['<more keys>'] = keys.length - MAX_KEYS;
    return out;
  }

  /** Keep top-level entries in order while the JSON fits the budget; cut or skip the rest. */
  function fit(m: Record<string, unknown>): Record<string, unknown> {
    const whole = JSON.stringify(m);
    if (Buffer.byteLength(whole, 'utf-8') <= DIAG_MAX_META_BYTES) return m;
    const out: Record<string, unknown> = {};
    let used = 2; // {}
    let skipped = 0;
    const reserve = 48; // room for the truncation marker
    for (const [k, v] of Object.entries(m)) {
      const entry = Buffer.byteLength(JSON.stringify(k) + ':' + JSON.stringify(v) + ',', 'utf-8');
      if (used + entry + reserve <= DIAG_MAX_META_BYTES) {
        out[k] = v;
        used += entry;
        continue;
      }
      const room = DIAG_MAX_META_BYTES - used - reserve - Buffer.byteLength(JSON.stringify(k), 'utf-8') - 48;
      if (typeof v === 'string' && room > 64) {
        // Characters, not bytes, but JSON of a cut string is at most ~6 bytes a char; divide to stay inside.
        const s = cut(v, Math.floor(room / 6));
        out[k] = s;
        used += Buffer.byteLength(JSON.stringify(k) + ':' + JSON.stringify(s) + ',', 'utf-8');
      } else {
        skipped++;
      }
    }
    out['<truncated>'] = skipped > 0 ? `${skipped} keys dropped` : true;
    return out;
  }

  return {
    text,
    meta(input) {
      try {
        return fit(object(input, 0, new WeakSet()));
      } catch {
        return { '<truncated>': 'unreadable meta' };
      }
    },
  };
}
