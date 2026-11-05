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

const OPAQUE_TOKEN = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_=+-]{32,}$/;
const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

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
    && !OPAQUE_TOKEN.test(value)
    && !hasSecretLookingContent(value);
}
