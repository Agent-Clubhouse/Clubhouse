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

const SECRET_ARG_NAME = /token|secret|password|passwd|api[_-]?key|auth/i;

/** `args` or `url` carrying a literal credential, which would otherwise be listed as part of the definition. */
export function definitionHoldsSecret(values: { command?: string; args?: string[]; url?: string }, isReference: (v: string) => boolean): boolean {
  const { command, args = [], url } = values;
  if ([command, url, ...args].some((v) => typeof v === 'string' && hasSecretLookingContent(v))) return true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const assignment = arg.match(/^-{1,2}([^=]+)=(.*)$/);
    if (assignment && SECRET_ARG_NAME.test(assignment[1]) && assignment[2] && !isReference(assignment[2])) return true;
    const flag = arg.match(/^-{1,2}(.+)$/);
    const next = args[i + 1];
    if (flag && !assignment && SECRET_ARG_NAME.test(flag[1]) && next !== undefined && !next.startsWith('-') && !isReference(next)) return true;
  }
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) return true;
      for (const [key, value] of parsed.searchParams) {
        if (SECRET_ARG_NAME.test(key) && !isReference(value)) return true;
      }
    } catch {
      // telemetry-exempt: not a URL (a wildcard or a reference), so there is no userinfo or query to read
    }
  }
  return false;
}
