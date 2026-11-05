/**
 * Which files the import inventory may treat as definitions (#2820). A file
 * ruled out here is only counted: its name, content and hash leave no trace.
 */
import * as path from 'path';

const SECRET_FILE_NAMES = /^\.env(\..*)?$|\.(pem|key|p12|pfx|keystore|jks)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|^\.(netrc|npmrc|pypirc)$|credential|secret|token|password|passwd/i;

const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  // An assignment with a literal value. `$`, `<`, `{` and `%` start a reference or a placeholder.
  /\b(?:api[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token)\s*[:=]\s*["']?[^\s"'$<{%]{8,}/i,
];

const DEFINITION_EXTENSIONS = new Set([
  '.md', '.mdx', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.tmpl', '.template',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.rb',
]);

/** Never walked: nobody wrote these as part of a definition. */
export const NON_DEFINITION_DIRS = new Set(['.git', 'node_modules']);

export function isSecretLookingName(name: string): boolean {
  return SECRET_FILE_NAMES.test(name);
}

export function hasSecretLookingContent(text: string): boolean {
  return SECRET_CONTENT.some((re) => re.test(text));
}

export function hasDefinitionExtension(name: string): boolean {
  return DEFINITION_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/** Stands in for a value that isn't reported. A definition holding one can't be used as it stands. */
export const WITHHELD = '<withheld>';

const SENSITIVE_NAME = /token|secret|passw(?:or)?d|pwd|^pass$|api[_-]?key|auth|credential|cookie|bearer|private[_-]?key|access[_-]?key|session|signature|^key$|^user$|^u$/i;
const HEADER_FLAG = /^(?:H|header)$/i;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
/** A long unbroken run with no path separator: nothing else in a command line looks like this. */
const OPAQUE_TOKEN = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_=+-]{32,}$/;

interface Redaction {
  isReference: (value: string) => boolean;
  withheld: number;
}

/** A value naming where a secret comes from, not the secret: `${VAR}`, `Bearer ${VAR}`, `@@Wildcard`. */
function isPlaceholder(value: string, r: Redaction): boolean {
  const bare = value.replace(/^(?:bearer|basic|token)\s+/i, '');
  return r.isReference(bare) || /^@@[A-Za-z]+$/.test(bare);
}

function withhold(r: Redaction): string {
  r.withheld++;
  return WITHHELD;
}

/** Every query or fragment value, and any userinfo, as env values are treated: only references stay. */
function redactUrl(url: string, r: Redaction): string {
  const match = url.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i);
  if (!match) return url;
  const [, scheme, authority, rest, query, fragment] = match;
  let host = authority;
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    const userinfo = authority.slice(0, at);
    const keep = userinfo.split(':').every((part) => isPlaceholder(part, r));
    host = `${keep ? userinfo : withhold(r)}@${authority.slice(at + 1)}`;
  }
  const params = (text: string | undefined, lead: string) => {
    if (!text) return '';
    return lead + text.slice(1).split('&').map((param) => {
      const eq = param.indexOf('=');
      if (eq === -1) return param && !isPlaceholder(param, r) ? withhold(r) : param;
      const value = param.slice(eq + 1);
      return !value || isPlaceholder(value, r) ? param : `${param.slice(0, eq)}=${withhold(r)}`;
    }).join('&');
  };
  return `${scheme}${host}${rest}${params(query, '?')}${params(fragment, '#')}`;
}

/** One string with its credential-shaped parts withheld and the rest left readable. */
function redactText(text: string, r: Redaction): string {
  let out = text.replace(URL_IN_TEXT, (url) => redactUrl(url, r));
  // `--token x` or `--token=x` inside one string, and `API_KEY=x`. The odd parts are the whitespace.
  const parts = out.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const token = parts[i];
    const flag = i >= 2 ? parts[i - 2].match(/^-{1,2}([\w.-]+)$/)?.[1] : undefined;
    const assignment = token.match(/^(-{0,2}([\w.-]+)=)(.+)$/);
    if (flag && !token.startsWith('-') && SENSITIVE_NAME.test(flag) && token !== WITHHELD && !isPlaceholder(token, r)) {
      parts[i] = withhold(r);
    } else if (assignment && SENSITIVE_NAME.test(assignment[2]) && assignment[3] !== WITHHELD && !isPlaceholder(assignment[3], r)) {
      parts[i] = `${assignment[1]}${withhold(r)}`;
    }
  }
  out = parts.join('');
  const header = out.match(/^(\s*[\w-]+\s*:\s*)(.+)$/);
  if (header && SENSITIVE_NAME.test(header[1]) && !isPlaceholder(header[2], r) && !header[2].includes(WITHHELD)) {
    out = `${header[1]}${withhold(r)}`;
  }
  return hasSecretLookingContent(out) || OPAQUE_TOKEN.test(out) ? withhold(r) : out;
}

/** The value after `-H`: only its name stays, as with a `headers` entry. */
function redactHeaderValue(value: string, r: Redaction): string {
  const header = value.match(/^(\s*[\w-]+\s*:\s*)(.*)$/);
  if (!header) return isPlaceholder(value, r) ? value : withhold(r);
  return isPlaceholder(header[2], r) ? value : `${header[1]}${withhold(r)}`;
}

function redactArgs(args: readonly string[], r: Redaction): string[] {
  return args.map((arg, i) => {
    const flag = i > 0 ? args[i - 1].match(/^-{1,2}([\w-]+)$/)?.[1] : undefined;
    if (flag && !arg.startsWith('-')) {
      if (HEADER_FLAG.test(flag)) return redactHeaderValue(arg, r);
      if (SENSITIVE_NAME.test(flag)) return isPlaceholder(arg, r) ? arg : withhold(r);
    }
    const inlineHeader = arg.match(/^(-{1,2}(?:H|header)=)(.*)$/i);
    if (inlineHeader) return `${inlineHeader[1]}${redactHeaderValue(inlineHeader[2], r)}`;
    return redactText(arg, r);
  });
}

/**
 * An MCP definition's command, args and URL with credentials replaced by
 * WITHHELD, and how many. Pattern-based: a bare positional secret of no known
 * shape gets through, which the PR's limits list says.
 */
export function redactDefinitionValues(
  values: { command?: string; args?: string[]; url?: string },
  isReference: (value: string) => boolean,
): { command?: string; args?: string[]; url?: string; withheld: number } {
  const r: Redaction = { isReference, withheld: 0 };
  const command = values.command === undefined ? undefined : redactText(values.command, r);
  const args = values.args && redactArgs(values.args, r);
  const url = values.url === undefined ? undefined : redactText(values.url, r);
  return { command, args, url, withheld: r.withheld };
}
