/**
 * Which files the import inventory may treat as definitions (#2820). A file
 * ruled out here is only counted: its name, content and hash leave no trace.
 */
import * as path from 'path';

const SECRET_FILE_NAMES = /^\.env(\..*)?$|\.(pem|key|p12|pfx|keystore|jks)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|^\.(netrc|npmrc|pypirc)$|credential|secret|token|password|passwd/i;

// Bounded runs only, so no match can scan far from its start. A regex can't be
// cancelled and runs on the main process; a test holds these to linear time.
const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}/,
  /\bgh[pousr]_[A-Za-z0-9]{36}/,
  /\bgithub_pat_[A-Za-z0-9_]{22}/,
  /\bsk-[A-Za-z0-9_-]{20}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10}/,
  // An assignment with a literal value. `$`, `<`, `{` and `%` start a reference or a placeholder.
  /\b(?:api[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token)[ \t]{0,8}[:=][ \t]{0,8}["']?[^\s"'$<{%]{8}/i,
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

const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
/** A control character, or U+FFFD, which is what a name that wasn't valid UTF-8 arrives with. */
function hasControlOrReplacement(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0xfffd) return true;
  }
  return false;
}

/**
 * One run of letters and digits that reads as generated rather than named: long,
 * all hex, or mixing lower, upper and digits. A heuristic, so `hunter2` passes. It
 * decides only what a result may show, and everything else about the value is
 * withheld anyway.
 */
function looksGenerated(run: string): boolean {
  if (run.length >= 32) return true;
  if (run.length >= 16 && /^[0-9a-f]+$/i.test(run) && /\d/.test(run)) return true;
  return run.length >= 12 && /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run);
}

function holdsGeneratedRun(value: string): boolean {
  return value.split(/[^A-Za-z0-9]+/).some(looksGenerated);
}

/**
 * A short plain name that doesn't look like a credential, for the few strings a
 * result may carry as written. Everything else about a definition is withheld, so
 * this decides what's shown; it isn't trying to find secrets in what's not.
 */
export function isSafeIdentifier(value: unknown, maxLength = 64): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && IDENTIFIER.test(value)
    && !holdsGeneratedRun(value)
    && !hasSecretLookingContent(value);
}

export function isSafeEnvName(value: unknown): value is string {
  return isSafeIdentifier(value) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/**
 * A file or folder name fit to report and to open. A name that wasn't valid UTF-8
 * arrives with U+FFFD in it and wouldn't open anyway.
 */
export function isSafeName(name: string): boolean {
  return name.length > 0
    && name.length <= 128
    && !hasControlOrReplacement(name)
    && !name.includes('://')
    && !(name.includes('@') && name.includes(':'))
    && !holdsGeneratedRun(name)
    && !hasSecretLookingContent(name);
}

/** A path as configured, if it's fit to show: every part a safe name, and bounded. */
export function isSafePathText(text: string): boolean {
  if (text.length > 512 || text.includes('@') || text.includes('://')) return false;
  const withoutDrive = text.replace(/^[A-Za-z]:(?=[\\/])/, '');
  if (withoutDrive.includes(':')) return false;
  return withoutDrive.split(/[\\/]/).filter(Boolean).every(isSafeName);
}
