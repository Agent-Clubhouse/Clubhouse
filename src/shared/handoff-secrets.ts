import { isSafeHandoffPath } from './handoff-manifest';

export const HANDOFF_SECRET_CONTENT_MAX_BYTES = 1024 ** 2;
const last = (parts: string[]) => parts[parts.length - 1];

const PATH_RULES = [
  { id: 'path.env', matches: (parts: string[]) => /^\.env(?:\..*)?$/.test(last(parts)) && !['.env.example', '.env.sample', '.env.template'].includes(last(parts)) },
  { id: 'path.private_key', matches: (parts: string[]) => /\.(?:pem|key)$/.test(last(parts)) },
  { id: 'path.pkcs12', matches: (parts: string[]) => /\.(?:p12|pfx)$/.test(last(parts)) },
  { id: 'path.ssh_identity', matches: (parts: string[]) => /^id_(?:rsa|ed25519)/.test(last(parts)) },
  { id: 'path.keystore', matches: (parts: string[]) => /\.keystore$/.test(last(parts)) },
  { id: 'path.credentials_json', matches: (parts: string[]) => /^credentials.*\.json$/.test(last(parts)) },
  { id: 'path.service_account_json', matches: (parts: string[]) => /service-account.*\.json$/.test(last(parts)) },
  { id: 'path.aws', matches: (parts: string[]) => parts.includes('.aws') },
  { id: 'path.ssh', matches: (parts: string[]) => parts.includes('.ssh') },
  { id: 'path.gnupg', matches: (parts: string[]) => parts.includes('.gnupg') },
  { id: 'path.docker_config', matches: (parts: string[]) => parts.some((part, index) => part === '.docker' && parts[index + 1] === 'config.json') },
  { id: 'path.terraform_state', matches: (parts: string[]) => /\.tfstate(?:\.backup)?$/.test(last(parts)) },
  { id: 'path.password_database', matches: (parts: string[]) => /\.kdbx$/.test(last(parts)) },
] as const;

const CONTENT_RULES = [
  { id: 'content.private_key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { id: 'content.aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'content.google_api_key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { id: 'content.ai_api_key', pattern: /\bsk-(?:(?:proj|svcacct|ant-api\d{2})-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'content.cloud_account_key', pattern: /\b(?:AccountKey|SharedAccessKey)\s*=\s*[A-Za-z0-9+/]{40,}={0,2}/i },
  { id: 'content.github_token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { id: 'content.gitlab_token', pattern: /\b(?:glpat|gloas|glptt|glrt|glcbt|glft|glimt|glsoat)-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'content.npm_token', pattern: /\bnpm_[A-Za-z0-9]{36,}\b/ },
  { id: 'content.pypi_token', pattern: /\bpypi-[A-Za-z0-9_-]{40,}\b/ },
  { id: 'content.slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { id: 'content.stripe_live_key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'content.connection_password', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { id: 'content.database_password', pattern: /\b(?:Server|Data Source|Host)\s*=[^;\r\n]+;[^\r\n]*\b(?:Password|Pwd)\s*=\s*[^;\s]+/i },
] as const;

export type HandoffSecretRule = typeof PATH_RULES[number]['id'] | typeof CONTENT_RULES[number]['id']
  | 'path.auth_config_uninspectable' | 'content.auth_config' | 'content.signed_jwt' | 'path.secret_token';

export interface HandoffSecretFinding {
  path: string;
  rule: HandoffSecretRule;
  line?: number;
}

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{16,}\b/g;
const authConfig = (path: string) => /(?:^|\/)\.(?:npmrc|pypirc|netrc)$/i.test(path);

function signedJwt(value: string): boolean {
  const decode = (part: string): unknown => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  try {
    const [headerPart, payloadPart] = value.split('.');
    const header = decode(headerPart);
    const payload = decode(payloadPart);
    return !!header && typeof header === 'object' && 'alg' in header && typeof header.alg === 'string'
      && header.alg.toLowerCase() !== 'none' && !!payload && typeof payload === 'object' && !Array.isArray(payload);
  } catch {
    // telemetry-exempt: malformed base64/JSON isn't a high-confidence signed JWT
    return false;
  }
}

/** File names themselves can contain credentials; diagnostics must not echo them. */
export function safeHandoffDiagnosticPath(path: string): string {
  let safe = path;
  for (const rule of CONTENT_RULES) safe = safe.replace(new RegExp(rule.pattern.source, `${rule.pattern.flags}g`), '[redacted]');
  safe = safe.replace(JWT, (candidate) => signedJwt(candidate) ? '[redacted]' : candidate);
  return safe.slice(0, 1024);
}

function decodedText(content: Uint8Array | undefined): string | undefined {
  if (!content || content.byteLength > HANDOFF_SECRET_CONTENT_MAX_BYTES || content.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    // telemetry-exempt: binary files receive name checks only, as specified by the transfer policy
    return undefined;
  }
}

/** Fixed rules only: no caller-supplied override or matched value in the report. */
export function scanHandoffSecrets(path: string, content?: Uint8Array): HandoffSecretFinding[] {
  if (!isSafeHandoffPath(path)) throw new Error('Invalid handoff file path.');
  const reportPath = safeHandoffDiagnosticPath(path);
  const findings: HandoffSecretFinding[] = [];
  const parts = path.toLowerCase().split('/');
  for (const rule of PATH_RULES) if (rule.matches(parts)) findings.push({ path: reportPath, rule: rule.id });
  if (reportPath !== path) findings.push({ path: reportPath, rule: 'path.secret_token' });
  const text = decodedText(content);
  if (text === undefined) {
    if (authConfig(path)) findings.push({ path: reportPath, rule: 'path.auth_config_uninspectable' });
    return findings;
  }
  const lines = text.split(/\r\n|\r|\n/);
  for (const rule of CONTENT_RULES) {
    const line = lines.findIndex((value) => rule.pattern.test(value));
    if (line !== -1) findings.push({ path: reportPath, rule: rule.id, line: line + 1 });
  }
  const jwtLine = lines.findIndex((line) => [...line.matchAll(JWT)].some((match) => signedJwt(match[0])));
  if (jwtLine !== -1) findings.push({ path: reportPath, rule: 'content.signed_jwt', line: jwtLine + 1 });
  if (authConfig(path)) {
    const line = lines.findIndex((value) => {
      const match = /(?:^|\s|:)(?:_authToken|_auth|_password|password)\s*[=:]\s*([^\s;#]+)/i.exec(value)
        ?? (/(?:^|\/)\.netrc$/i.test(path) ? /\bpassword\s+(\S+)/i.exec(value) : null);
      return !!match && !/^(?:\$\{[^}]+\}|<[^>]+>)$/.test(match[1]);
    });
    if (line !== -1) findings.push({ path: reportPath, rule: 'content.auth_config', line: line + 1 });
  }
  return findings;
}
