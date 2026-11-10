/**
 * What may enter the asset catalog (#2737). Schemas are closed: an unknown field
 * is an error, so a provider, a credential or a worktree can't arrive under a
 * name nobody thought of. Saved revisions are immutable and kept, so a secret
 * that got in could never be taken back out: secrets are refused here, not
 * scrubbed later. Issues name a location and never a value.
 */

import {
  ACCESS_LEVELS,
  validateOrchestrationPatch,
  type AgentAccessLevel,
} from '../../../shared/orchestration-policy';
import { frontMatterLaunchSettings } from '../../../shared/front-matter';
import type {
  AssetAgentMetadata,
  AssetKind,
  AssetPayload,
  AssetPayloadByKind,
  AssetPreview,
  AssetProjection,
  BlockAssetPayload,
  BlockRef,
  CatalogEntry,
  CompositionInput,
  InstanceEntry,
  InstanceSubagent,
  McpAssetPayload,
  SkillAssetPayload,
  SkillFile,
  SubagentAssetPayload,
  SubagentRef,
  SubagentReviewField,
  SubagentToolField,
  TemplateAssetPayload,
  TemplateOperationalDefaults,
  UpstreamPackage,
  ValidationCode,
  ValidationIssue,
} from '../../../shared/asset-catalog-types';
import { isSafeSkillPathSegment, MAX_SKILL_PATH_CHARS, SKILL_ENTRYPOINT } from '../../../shared/skill-paths';
import { containsSecretToken, isSecretKey, redactSecretValues, REDACTED } from '../../telemetry/diag-redaction';

export const MAX_BLOCK_BYTES = 1024 * 1024;
export const MAX_SUBAGENT_PROVIDER_BYTES = 256 * 1024;
export const MAX_PROVIDER_DEPTH = 8;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_SKILL_FILES = 500;

const MAX_NAME_CHARS = 120;

const OBJECT_KEY_TRAPS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9][\w.:-]{0,127}$/;
/** An asset id is also a directory name, so it has to be a safe one on every platform. */
const ASSET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SERVER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_DESCRIPTION_CHARS = 2000;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Clubhouse's own: its MCP bridge, its skills, and the variables it sets. Only a built-in may project here. */
const RESERVED_NAME_RE = /^clubhouse(?:[-_.].*)?$/i;
const RESERVED_ENV_RE = /^CLUBHOUSE_/i;

/** Files that hold credentials by convention. A skill bundle never carries them. */
const CREDENTIAL_FILE_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|.*\.(?:pem|key|p12|pfx))$/i;

/** Launch settings, under the spellings they go by. Separately coded so a template's refusal says why. */
const FORBIDDEN_TEMPLATE_FIELDS = new Set([
  'provider', 'providerid', 'providerrouting', 'orchestrator',
  'model', 'modelid', 'modelrouting', 'modelreasoningeffort',
  'effort', 'reasoningeffort',
  'contextwindow', 'routing', 'helperrouting',
]);

const normalizedField = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** How file systems and CLIs may see two spellings as one. */
export function collisionKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/** An agent, run, project or built-in id: only ever a key or a value in the index. Never something shaped like a credential. */
export function isCatalogId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value) && !OBJECT_KEY_TRAPS.has(value) && !containsSecretToken(value);
}

/** Lower case only: on macOS and Windows, two ids that differ by case would be one directory. */
export function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && ASSET_ID_RE.test(value) && !WINDOWS_DEVICE_RE.test(value) && !OBJECT_KEY_TRAPS.has(value) && !containsSecretToken(value);
}

/** Ids arrive from outside, so index lookups can't fall through to a prototype. */
export function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class Issues {
  readonly list: ValidationIssue[] = [];

  add(code: ValidationCode, path: string): void {
    this.list.push({ code, path });
  }

  /** Every key must be one of `allowed`. */
  closed(raw: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) this.add('unknown_field', `${prefix}${safeKey(key)}`);
    }
  }
}

/** A key from a payload can be anything, including a credential pasted in the wrong place. */
function safeKey(key: string): string {
  return /^[\w.-]{1,64}$/.test(key) && !containsSecretToken(key) ? key : '<key>';
}

function optionalString(raw: Record<string, unknown>, key: string, issues: Issues): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) {
    issues.add('invalid_shape', key);
    return undefined;
  }
  return value;
}

function stringList(value: unknown, path: string, issues: Issues): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    issues.add('invalid_shape', path);
    return [];
  }
  return value as string[];
}

/** A literal under a name that holds secrets. Plain whole numbers pass: `MAX_TOKENS=4000`. */
function isSecretLiteral(name: string, value: string): boolean {
  return isSecretKey(name) && !/^\d{1,9}$/.test(value);
}

function hasSecretValue(value: string): boolean {
  return redactSecretValues(value) !== value;
}

// ── MCP ──────────────────────────────────────────────────────────────────

const MCP_FIELDS = ['serverKey', 'transport', 'command', 'args', 'url', 'env', 'envVars', 'auth', 'upstream'] as const;

/** A flag named like a secret takes its value from the next argument or after `=`, and the value is literal. */
const SECRET_FLAG_RE = /^--?([A-Za-z][\w-]*)(?:=(.*))?$/;
/** Flags too short or common for the shared list of secret names. */
const SECRET_FLAG_NAME_RE = /^(?:pass|pwd|pat|cred|creds|key)$/i;

function isSecretFlag(name: string): boolean {
  return isSecretKey(name) || SECRET_FLAG_NAME_RE.test(name);
}

/** Env names that hold secrets: the secret flag names, plus `OPENAI_KEY`, `DB_PASS`, `DB_PWD`, `GH_PAT`, `X_TOKEN`. */
const SECRET_ENV_SUFFIX_RE = /_(?:key|pass|pwd|pat|token)$/i;

export function isSecretEnvName(name: string): boolean {
  return isSecretFlag(name) || SECRET_ENV_SUFFIX_RE.test(name);
}

/**
 * Which arguments give a secret away. A secret flag's next argument counts even
 * if it starts with a dash: a password can. Whole-number values pass, for
 * `--max-tokens 4000`.
 */
function secretArgs(args: readonly string[]): number[] {
  return args.flatMap((arg, index) => {
    const flag = SECRET_FLAG_RE.exec(arg);
    if (hasSecretValue(arg)) return [index];
    if (!flag || !isSecretFlag(flag[1])) return [];
    const value = flag[2] ?? args[index + 1];
    return value !== undefined && !/^\d{1,9}$/.test(value) ? [index] : [];
  });
}

function checkArgs(args: string[], issues: Issues): void {
  for (const index of secretArgs(args)) issues.add('secret_value', `args[${index}]`);
}

/** Webhook URLs are the credential: whoever holds one can post. */
const WEBHOOK_URL_RE = /\/\/(?:hooks\.slack\.com\/(?:services|workflows)\/|(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/|[\w.-]+\.webhook\.office\.com\/)/i;

function checkUrl(url: string, issues: Issues): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // telemetry-exempt: reported to the caller as a validation issue
    issues.add('invalid_url', 'url');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') issues.add('invalid_url', 'url');
  if (parsed.username || parsed.password) issues.add('secret_value', 'url');
  for (const key of parsed.searchParams.keys()) {
    if (isSecretFlag(key)) issues.add('secret_value', 'url');
  }
  if (WEBHOOK_URL_RE.test(url)) issues.add('secret_value', 'url');
  // Fragments and matrix parameters aren't query strings, and carry tokens too.
  if (hasSecretValue(url)) issues.add('secret_value', 'url');
}

function checkUpstream(raw: unknown, issues: Issues): UpstreamPackage | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || typeof raw.package !== 'string' || !raw.package || (raw.version !== undefined && typeof raw.version !== 'string')) {
    issues.add('invalid_shape', 'upstream');
    return undefined;
  }
  issues.closed(raw, ['package', 'version'], 'upstream.');
  if (hasSecretValue(raw.package) || (typeof raw.version === 'string' && hasSecretValue(raw.version))) issues.add('secret_value', 'upstream');
  return { package: raw.package, ...(raw.version !== undefined && { version: raw.version as string }) };
}

function validateMcp(raw: Record<string, unknown>, issues: Issues, reservedAllowed: boolean): McpAssetPayload | null {
  issues.closed(raw, MCP_FIELDS, '');
  const { serverKey, transport } = raw;
  if (typeof serverKey !== 'string' || !SERVER_KEY_RE.test(serverKey) || OBJECT_KEY_TRAPS.has(serverKey) || containsSecretToken(serverKey)) {
    issues.add('invalid_identifier', 'serverKey');
  } else if (RESERVED_NAME_RE.test(serverKey) && !reservedAllowed) {
    issues.add('reserved_namespace', 'serverKey');
  }
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') issues.add('invalid_shape', 'transport');

  const command = optionalString(raw, 'command', issues);
  const url = optionalString(raw, 'url', issues);
  const args = stringList(raw.args, 'args', issues);
  if (transport === 'stdio' && (!command || url)) issues.add('invalid_transport_fields', 'transport');
  if ((transport === 'http' || transport === 'sse') && (!url || command || args.length > 0)) issues.add('invalid_transport_fields', 'transport');
  if (command && hasSecretValue(command)) issues.add('secret_value', 'command');
  checkArgs(args, issues);
  if (url) checkUrl(url, issues);

  const env: Record<string, string> = {};
  if (raw.env !== undefined && !isRecord(raw.env)) issues.add('invalid_shape', 'env');
  for (const [name, value] of Object.entries(isRecord(raw.env) ? raw.env : {})) {
    const at = `env.${safeKey(name)}`;
    if (!ENV_NAME_RE.test(name) || OBJECT_KEY_TRAPS.has(name) || containsSecretToken(name)) issues.add('invalid_identifier', at);
    else if (RESERVED_ENV_RE.test(name)) issues.add('reserved_namespace', at);
    if (typeof value !== 'string') {
      issues.add('invalid_shape', at);
      continue;
    }
    if ((isSecretEnvName(name) && !/^\d{1,9}$/.test(value)) || hasSecretValue(value)) issues.add('secret_value', at);
    env[name] = value;
  }

  const envVars = stringList(raw.envVars, 'envVars', issues);
  envVars.forEach((name, index) => {
    if (!ENV_NAME_RE.test(name) || OBJECT_KEY_TRAPS.has(name) || containsSecretToken(name)) issues.add('invalid_identifier', `envVars[${index}]`);
    else if (RESERVED_ENV_RE.test(name)) issues.add('reserved_namespace', `envVars[${index}]`);
    else if (name in env) issues.add('invalid_shape', `envVars[${index}]`);
  });
  if (new Set(envVars).size !== envVars.length) issues.add('invalid_shape', 'envVars');

  if (raw.auth !== undefined && raw.auth !== 'external') issues.add('invalid_shape', 'auth');
  const upstream = checkUpstream(raw.upstream, issues);

  return {
    serverKey: serverKey as string,
    transport: transport as McpAssetPayload['transport'],
    ...(command !== undefined && { command }),
    ...(args.length > 0 && { args }),
    ...(url !== undefined && { url }),
    ...(Object.keys(env).length > 0 && { env }),
    ...(envVars.length > 0 && { envVars }),
    ...(raw.auth === 'external' && { auth: 'external' as const }),
    ...(upstream && { upstream }),
  };
}

// ── Skills ───────────────────────────────────────────────────────────────

/** The same rule the skill editors check before saving (#3247). */
const isSafePathSegment = isSafeSkillPathSegment;

function decodedSize(file: SkillFile): number {
  return file.encoding === 'base64' ? Buffer.from(file.content, 'base64').byteLength : Buffer.byteLength(file.content, 'utf8');
}

function isCanonicalBase64(content: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(content) && content.length % 4 === 0;
}

function validateSkill(raw: Record<string, unknown>, issues: Issues, reservedAllowed: boolean): SkillAssetPayload | null {
  issues.closed(raw, ['skillName', 'files'], '');
  const { skillName, files } = raw;
  if (typeof skillName !== 'string' || !isSafePathSegment(skillName) || skillName.length > 64 || OBJECT_KEY_TRAPS.has(skillName) || containsSecretToken(skillName)) {
    issues.add('invalid_identifier', 'skillName');
  } else if (RESERVED_NAME_RE.test(skillName) && !reservedAllowed) {
    issues.add('reserved_namespace', 'skillName');
  }
  if (!Array.isArray(files)) {
    issues.add('invalid_shape', 'files');
    return null;
  }
  if (files.length > MAX_SKILL_FILES) issues.add('too_large', 'files');

  const seen = new Set<string>();
  const clean: SkillFile[] = [];
  let total = 0;
  files.forEach((file: unknown, index) => {
    const at = `files[${index}]`;
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
      issues.add('invalid_shape', at);
      return;
    }
    issues.closed(file, ['path', 'content', 'encoding', 'executable'], `${at}.`);
    const segments = file.path.split('/');
    if (file.path.length > MAX_SKILL_PATH_CHARS || !segments.every(isSafePathSegment)) {
      issues.add('invalid_skill_path', `${at}.path`);
      return;
    }
    if (segments.some((segment) => CREDENTIAL_FILE_RE.test(segment))) issues.add('credential_file', `${at}.path`);
    if (containsSecretToken(file.path)) issues.add('secret_value', `${at}.path`);
    const key = collisionKey(file.path);
    if (seen.has(key)) issues.add('duplicate_skill_path', `${at}.path`);
    seen.add(key);

    if (file.encoding !== undefined && file.encoding !== 'utf8' && file.encoding !== 'base64') issues.add('invalid_encoding', `${at}.encoding`);
    if (file.encoding === 'base64' && !isCanonicalBase64(file.content)) issues.add('invalid_encoding', `${at}.content`);
    if (file.executable !== undefined && typeof file.executable !== 'boolean') issues.add('invalid_shape', `${at}.executable`);

    const entry: SkillFile = {
      path: file.path,
      content: file.content,
      ...(file.encoding === 'base64' && { encoding: 'base64' as const }),
      ...(file.executable === true && { executable: true }),
    };
    const size = decodedSize(entry);
    total += size;
    if (size > MAX_SKILL_FILE_BYTES) issues.add('too_large', `${at}.content`);
    const text = entry.encoding === 'base64' ? Buffer.from(entry.content, 'base64').toString('latin1') : entry.content;
    if (containsSecretToken(text)) issues.add('secret_value', `${at}.content`);
    clean.push(entry);
  });
  if (total > MAX_SKILL_BUNDLE_BYTES) issues.add('too_large', 'files');

  // A path can't be both a file and a directory: `a` beside `a/b`.
  for (const key of seen) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) issues.add('duplicate_skill_path', 'files');
    }
  }
  if (!clean.some((file) => file.path === SKILL_ENTRYPOINT)) issues.add('missing_skill_entrypoint', 'files');
  clean.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { skillName: skillName as string, files: clean };
}

// ── Blocks ───────────────────────────────────────────────────────────────

function validateBlock(raw: Record<string, unknown>, issues: Issues): BlockAssetPayload | null {
  issues.closed(raw, ['content'], '');
  const { content } = raw;
  if (typeof content !== 'string' || !content.trim()) {
    issues.add('invalid_shape', 'content');
    return null;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BLOCK_BYTES) issues.add('too_large', 'content');
  if (containsSecretToken(content)) issues.add('secret_value', 'content');
  // Front matter like the old persona files' carries model and orchestrator. An import splits them out, so a block can't smuggle them in.
  if (frontMatterLaunchSettings(content).length > 0) issues.add('launch_settings_in_instruction', 'content');
  return { content };
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** An ordered list of stable entry ids, each referring to one block revision. Each id and each block once. */
function validateBlockRefs(raw: unknown, path: string, issues: Issues): BlockRef[] {
  if (!Array.isArray(raw)) {
    issues.add('invalid_shape', path);
    return [];
  }
  const refs: BlockRef[] = [];
  const entryIds = new Set<string>();
  const blockIds = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(item)) {
      issues.add('invalid_shape', at);
      return;
    }
    issues.closed(item, ['entryId', 'blockId', 'blockRevision'], `${at}.`);
    if (!isCatalogId(item.entryId)) issues.add('invalid_identifier', `${at}.entryId`);
    if (!isAssetId(item.blockId)) issues.add('invalid_identifier', `${at}.blockId`);
    if (!isRevision(item.blockRevision)) issues.add('invalid_revision', `${at}.blockRevision`);
    if (entryIds.has(item.entryId as string) || blockIds.has(item.blockId as string)) issues.add('duplicate_reference', at);
    entryIds.add(item.entryId as string);
    blockIds.add(item.blockId as string);
    refs.push({ entryId: item.entryId as string, blockId: item.blockId as string, blockRevision: item.blockRevision as number });
  });
  return refs;
}

function validateAssetIdList(raw: unknown, path: string, issues: Issues): string[] {
  const list = stringList(raw, path, issues);
  list.forEach((id, index) => {
    if (!isAssetId(id)) issues.add('invalid_identifier', `${path}[${index}]`);
  });
  if (new Set(list).size !== list.length) issues.add('duplicate_reference', path);
  return list;
}

// ── Templates ────────────────────────────────────────────────────────────

const TEMPLATE_FIELDS = ['entries', 'subagents', 'skills', 'mcps', 'operationalDefaults'] as const;

function checkForbidden(raw: Record<string, unknown>, prefix: string, issues: Issues, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_TEMPLATE_FIELDS.has(normalizedField(key))) issues.add('forbidden_template_field', `${prefix}${safeKey(key)}`);
    else if (!allowed.includes(key)) issues.add('unknown_field', `${prefix}${safeKey(key)}`);
  }
}

function validateOperationalDefaults(raw: unknown, issues: Issues): TemplateOperationalDefaults | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.add('invalid_operational_default', 'operationalDefaults');
    return undefined;
  }
  const { agentAccess, ...policy } = raw;
  const known = ['orchestrate', 'access', 'control', 'maxHelpers', 'crossProjectHelpers', 'connectToDispatcher', 'autoHelpers'];
  checkForbidden(policy, 'operationalDefaults.', issues, known);
  const out: TemplateOperationalDefaults = {};
  if (agentAccess !== undefined) {
    if (ACCESS_LEVELS.includes(agentAccess as AgentAccessLevel)) out.agentAccess = agentAccess as AgentAccessLevel;
    else issues.add('invalid_operational_default', 'operationalDefaults.agentAccess');
  }
  for (const key of known) {
    const value = policy[key];
    if (value === undefined) continue;
    try {
      // `null` means "clear" in a patch, which has no meaning in a default.
      if (value === null) throw new Error('null');
      Object.assign(out, validateOrchestrationPatch({ [key]: value }));
    } catch {
      // telemetry-exempt: reported to the caller as a validation issue
      issues.add('invalid_operational_default', `operationalDefaults.${key}`);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateSubagentRefs(raw: unknown, issues: Issues): SubagentRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.add('invalid_shape', 'subagents');
    return [];
  }
  const refs: SubagentRef[] = [];
  const entryIds = new Set<string>();
  const subagentIds = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const at = `subagents[${index}]`;
    if (!isRecord(item)) {
      issues.add('invalid_shape', at);
      return;
    }
    issues.closed(item, ['entryId', 'subagentId', 'subagentRevision'], `${at}.`);
    if (!isCatalogId(item.entryId)) issues.add('invalid_identifier', `${at}.entryId`);
    if (!isAssetId(item.subagentId)) issues.add('invalid_identifier', `${at}.subagentId`);
    if (!isRevision(item.subagentRevision)) issues.add('invalid_revision', `${at}.subagentRevision`);
    if (entryIds.has(item.entryId as string) || subagentIds.has(item.subagentId as string)) issues.add('duplicate_reference', at);
    entryIds.add(item.entryId as string);
    subagentIds.add(item.subagentId as string);
    refs.push({ entryId: item.entryId as string, subagentId: item.subagentId as string, subagentRevision: item.subagentRevision as number });
  });
  // A set: saved in one order, so the same set always hashes the same.
  return refs.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
}

function validateTemplate(raw: Record<string, unknown>, issues: Issues): TemplateAssetPayload | null {
  checkForbidden(raw, '', issues, [...TEMPLATE_FIELDS, 'templates', 'template']);
  if ('templates' in raw || 'template' in raw) issues.add('nested_template', 'templates' in raw ? 'templates' : 'template');
  const entries = validateBlockRefs(raw.entries, 'entries', issues);
  if (Array.isArray(raw.entries) && raw.entries.length === 0) issues.add('no_instruction_entries', 'entries');
  const subagents = validateSubagentRefs(raw.subagents, issues);
  const skills = validateAssetIdList(raw.skills, 'skills', issues);
  const mcps = validateAssetIdList(raw.mcps, 'mcps', issues);
  const operationalDefaults = validateOperationalDefaults(raw.operationalDefaults, issues);
  return { entries, subagents, skills, mcps, ...(operationalDefaults && { operationalDefaults }) };
}

// ── Native subagents ─────────────────────────────────────────────────────

/**
 * Provider fields believed harmless, by provider. A short allowlist, not a
 * statement about any CLI: it comes from docs and source and isn't verified
 * against a running version. Everything else, under any spelling and for any other
 * provider, blocks for a person, because a list of dangerous names is always
 * missing one. Activation decides what a delivery path really supports.
 */
const MODEL_VALUE_RE = /^[A-Za-z0-9][\w.:/@[\]-]{0,127}$/;
const WORD_VALUE_RE = /^[A-Za-z0-9#][\w#-]{0,31}$/;
/** A tool, with an optional scope: `Read`, `mcp__server__tool`, `Bash(git status)`. Not a flag, an assignment or JSON. */
const TOOL_RULE_RE = /^[A-Za-z][\w-]*(?:\(.*\))?$/;

function isToolList(value: unknown): boolean {
  const items = typeof value === 'string' ? value.split(',').map((item) => item.trim()) : value;
  return Array.isArray(items) && items.every((item) => typeof item === 'string' && TOOL_RULE_RE.test(item));
}

/** Each field's value is checked by shape too: a known name is no reason to trust what's in it. */
const KNOWN_PROVIDER_FIELDS: Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>> = {
  claude: {
    model: (value) => typeof value === 'string' && MODEL_VALUE_RE.test(value),
    effort: (value) => typeof value === 'string' && WORD_VALUE_RE.test(value),
    color: (value) => typeof value === 'string' && WORD_VALUE_RE.test(value),
    maxturns: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    tools: isToolList,
    disallowedtools: isToolList,
  },
};

/** Named to say why it's blocked. These block whether or not they're named here. */
const AUTHORITY_FIELD_RE = /permission|hook|dangerous|bypass|sandbox|approval|yolo|autoapprove|allowall|trust/;
const INLINE_MCP_FIELDS = new Set(['mcpservers', 'mcpserver', 'mcp', 'mcpconfig']);
const SERVER_NAME_RE = /^[\w.-]{1,64}$/;

/** A string holding JSON is that JSON: a stringified field counts as the field. */
function parsedJson(value: string): unknown {
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[') && !text.startsWith('"')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // telemetry-exempt: not JSON, so it's only text
    return undefined;
  }
}

/** Strings in an inline MCP definition are config, where a secret name means a secret. Elsewhere they can be prose. */
function scanProviderValue(value: unknown, path: string, depth: number, inMcp: boolean, issues: Issues): void {
  if (depth > MAX_PROVIDER_DEPTH) {
    issues.add('too_large', path);
    return;
  }
  if (typeof value === 'string') {
    if (containsSecretToken(value) || (inMcp && hasSecretValue(value))) issues.add('secret_value', path);
    const parsed = parsedJson(value);
    if (parsed !== undefined) scanProviderValue(parsed, path, depth + 1, true, issues);
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string') && secretArgs(value as string[]).length > 0) issues.add('secret_value', path);
    value.forEach((item, index) => scanProviderValue(item, `${path}[${index}]`, depth + 1, inMcp, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const at = `${path}.${safeKey(key)}`;
    if (OBJECT_KEY_TRAPS.has(key)) {
      issues.add('invalid_identifier', at);
      continue;
    }
    if (isSecretKey(key) && typeof item === 'string' && isSecretLiteral(key, item)) issues.add('secret_value', at);
    scanProviderValue(item, at, depth + 1, inMcp || INLINE_MCP_FIELDS.has(normalizedField(key)), issues);
  }
}

/** Whether a value, at any depth and in any stringified form, names something that raises authority. */
function holdsAuthority(value: unknown, depth = 0): boolean {
  if (depth > MAX_PROVIDER_DEPTH) return true;
  if (typeof value === 'string') {
    const parsed = parsedJson(value);
    return parsed !== undefined ? holdsAuthority(parsed, depth + 1) : AUTHORITY_FIELD_RE.test(normalizedField(value));
  }
  if (Array.isArray(value)) return value.some((item) => holdsAuthority(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => (
    AUTHORITY_FIELD_RE.test(normalizedField(key)) || INLINE_MCP_FIELDS.has(normalizedField(key)) || holdsAuthority(item, depth + 1)
  ));
}

function reviewReason(provider: string, key: string, value: unknown): SubagentReviewField['reason'] | null {
  const field = normalizedField(key);
  if (AUTHORITY_FIELD_RE.test(field)) return 'authority';
  if (INLINE_MCP_FIELDS.has(field)) {
    // A reference by name is fine, if it isn't Clubhouse's own. A definition written inline can run anything.
    const names = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [value];
    const plain = names.every((name) => typeof name === 'string' && SERVER_NAME_RE.test(name) && !RESERVED_NAME_RE.test(name));
    if (!plain) return 'authority';
    return provider === 'claude' && field === 'mcpservers' ? null : 'unknown';
  }
  const check = hasOwn(KNOWN_PROVIDER_FIELDS, provider) && hasOwn(KNOWN_PROVIDER_FIELDS[provider], field) ? KNOWN_PROVIDER_FIELDS[provider][field] : null;
  if (check?.(value)) return null;
  return holdsAuthority(value) ? 'authority' : 'unknown';
}

function reviewFieldsOf(provider: SubagentAssetPayload['provider']): SubagentReviewField[] {
  const fields: SubagentReviewField[] = [];
  for (const [id, section] of Object.entries(provider ?? {})) {
    for (const [key, value] of Object.entries(section)) {
      const reason = reviewReason(hasOwn(KNOWN_PROVIDER_FIELDS, id) ? id : '', key, value);
      if (reason) fields.push({ path: `${safeKey(id)}.${safeKey(key)}`, reason });
    }
  }
  return fields.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const TOOL_ALLOW_FIELDS = new Set(['tools', 'allowedtools', 'availabletools']);
const TOOL_DENY_FIELDS = new Set(['disallowedtools', 'deniedtools', 'excludedtools']);
const DELEGATION_TOOL_RE = /^(?:Agent|Task)(?:\(.*\))?$/;
const CLUBHOUSE_MCP_TOOL_RE = /^mcp__clubhouse(?:__|$)/i;
/** A delegation scope is a list of names. Any other tool's scope is a command, which can hold anything. */
const SIMPLE_SCOPE_RE = /^[\w-]+\([\w\s,*-]*\)$/;
const USERINFO_ARG_RE = /(?:^|[\s(])(?:-u|--user)[\s=]+\S+:\S+/;

/** How a rule shows: its name, and its scope only when that's plainly just names. */
function toolDisplayName(rule: string): string {
  const open = rule.indexOf('(');
  if (open < 0 || (DELEGATION_TOOL_RE.test(rule) && SIMPLE_SCOPE_RE.test(rule))) return redactSecretValues(rule);
  return `${redactSecretValues(rule.slice(0, open))}(${REDACTED})`;
}

/** A list of names, or the comma-separated string native definition files use. Anything else stays unlisted, and says so. */
function toolFieldOf(value: unknown, path: string, list: SubagentToolField['list']): SubagentToolField {
  const items: unknown[] = typeof value === 'string' ? value.split(',').map((name) => name.trim()).filter(Boolean) : Array.isArray(value) ? value : [value];
  const names = items.filter((item): item is string => typeof item === 'string').map(toolDisplayName);
  return {
    path,
    list,
    names,
    delegation: names.filter((name) => DELEGATION_TOOL_RE.test(name)),
    clubhouseMcp: names.filter((name) => CLUBHOUSE_MCP_TOOL_RE.test(name)),
    hasUnlisted: names.length !== items.length,
  };
}

function collectToolFields(value: unknown, path: string, out: SubagentToolField[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectToolFields(item, `${path}[${index}]`, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const at = `${path}.${safeKey(key)}`;
    const field = normalizedField(key);
    if (TOOL_ALLOW_FIELDS.has(field)) out.push(toolFieldOf(item, at, 'allow'));
    else if (TOOL_DENY_FIELDS.has(field)) out.push(toolFieldOf(item, at, 'deny'));
    else collectToolFields(item, at, out);
  }
}

function collectToolValues(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolValues(item, out);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const field = normalizedField(key);
      if (TOOL_ALLOW_FIELDS.has(field) || TOOL_DENY_FIELDS.has(field)) out.push(...(Array.isArray(item) ? item : [item]));
      else collectToolValues(item, out);
    }
  }
}

function toolFieldsOf(provider: SubagentAssetPayload['provider']): SubagentToolField[] {
  const fields: SubagentToolField[] = [];
  for (const [id, section] of Object.entries(provider ?? {})) collectToolFields(section, safeKey(id), fields);
  return fields.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function validateSubagent(raw: Record<string, unknown>, issues: Issues, reservedAllowed: boolean): SubagentAssetPayload | null {
  issues.closed(raw, ['agentName', 'description', 'blocks', 'skills', 'mcps', 'provider'], '');
  const { agentName, description, provider } = raw;
  if (typeof agentName !== 'string' || !AGENT_NAME_RE.test(agentName) || OBJECT_KEY_TRAPS.has(agentName) || containsSecretToken(agentName)) {
    issues.add('invalid_identifier', 'agentName');
  } else if (RESERVED_NAME_RE.test(agentName) && !reservedAllowed) {
    issues.add('reserved_namespace', 'agentName');
  }
  if (typeof description !== 'string' || !description.trim() || description.length > MAX_DESCRIPTION_CHARS) {
    issues.add('invalid_shape', 'description');
  } else if (containsSecretToken(description)) {
    issues.add('secret_value', 'description');
  }
  const blocks = validateBlockRefs(raw.blocks, 'blocks', issues);
  if (Array.isArray(raw.blocks) && raw.blocks.length === 0) issues.add('no_instruction_entries', 'blocks');
  const skills = validateAssetIdList(raw.skills, 'skills', issues);
  const mcps = validateAssetIdList(raw.mcps, 'mcps', issues);

  if (provider !== undefined) {
    if (!isRecord(provider)) {
      issues.add('invalid_shape', 'provider');
    } else {
      for (const [id, section] of Object.entries(provider)) {
        const at = `provider.${safeKey(id)}`;
        if (!isCatalogId(id)) issues.add('invalid_identifier', at);
        if (!isRecord(section)) {
          issues.add('invalid_shape', at);
          continue;
        }
        scanProviderValue(section, at, 0, false, issues);
        const tools: unknown[] = [];
        collectToolValues(section, tools);
        if (tools.some((rule) => typeof rule === 'string' && USERINFO_ARG_RE.test(rule))) issues.add('secret_value', at);
      }
      if (Buffer.byteLength(JSON.stringify(provider), 'utf8') > MAX_SUBAGENT_PROVIDER_BYTES) issues.add('too_large', 'provider');
    }
  }
  return {
    agentName: agentName as string,
    description: description as string,
    blocks,
    skills,
    mcps,
    ...(isRecord(provider) && Object.keys(provider).length > 0 && { provider: provider as SubagentAssetPayload['provider'] }),
  };
}

// ── Entry points ─────────────────────────────────────────────────────────

export type PayloadValidation<K extends AssetKind> =
  | { ok: true; payload: AssetPayloadByKind[K]; projection: AssetProjection }
  | { ok: false; issues: ValidationIssue[] };

export function projectionOf(kind: AssetKind, payload: AssetPayload): AssetProjection {
  switch (kind) {
    case 'mcp': {
      const mcp = payload as McpAssetPayload;
      return {
        kind,
        serverKey: mcp.serverKey,
        transport: mcp.transport,
        envVars: [...(mcp.envVars ?? [])].sort(),
        ...(mcp.auth && { auth: mcp.auth }),
        ...(mcp.upstream && {
          upstream: { ...mcp.upstream, floating: !mcp.upstream.version || !EXACT_VERSION_RE.test(mcp.upstream.version) },
        }),
      };
    }
    case 'skill': {
      const skill = payload as SkillAssetPayload;
      return { kind, skillName: skill.skillName, filePaths: skill.files.map((file) => file.path) };
    }
    case 'block':
      return { kind, bytes: Buffer.byteLength((payload as BlockAssetPayload).content, 'utf8') };
    case 'subagent': {
      const subagent = payload as SubagentAssetPayload;
      return {
        kind,
        agentName: subagent.agentName,
        blocks: subagent.blocks,
        skills: subagent.skills,
        mcps: subagent.mcps,
        providers: Object.keys(subagent.provider ?? {}).sort(),
        reviewFields: reviewFieldsOf(subagent.provider),
        toolFields: toolFieldsOf(subagent.provider),
      };
    }
    case 'template': {
      const template = payload as TemplateAssetPayload;
      return {
        kind,
        entries: template.entries,
        subagents: template.subagents,
        skills: template.skills,
        mcps: template.mcps,
        ...(template.operationalDefaults && { operationalDefaults: template.operationalDefaults }),
      };
    }
  }
}

/** `reservedAllowed`: only a built-in may project into Clubhouse's namespaces. */
export function validatePayload<K extends AssetKind>(kind: K, raw: unknown, reservedAllowed = false): PayloadValidation<K> {
  const issues = new Issues();
  if (!isRecord(raw)) return { ok: false, issues: [{ code: 'invalid_shape', path: '' }] };
  let payload: AssetPayload | null = null;
  switch (kind) {
    case 'mcp': payload = validateMcp(raw, issues, reservedAllowed); break;
    case 'skill': payload = validateSkill(raw, issues, reservedAllowed); break;
    case 'block': payload = validateBlock(raw, issues); break;
    case 'subagent': payload = validateSubagent(raw, issues, reservedAllowed); break;
    case 'template': payload = validateTemplate(raw, issues); break;
    default: issues.add('invalid_shape', 'kind');
  }
  if (issues.list.length > 0 || !payload) return { ok: false, issues: issues.list };
  return { ok: true, payload: payload as AssetPayloadByKind[K], projection: projectionOf(kind, payload) };
}

export function nameIssues(name: unknown): ValidationIssue[] {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_CHARS || CONTROL_CHARS_RE.test(name)) {
    return [{ code: 'invalid_name', path: 'name' }];
  }
  return containsSecretToken(name) ? [{ code: 'secret_value', path: 'name' }] : [];
}

/** Closed, so nothing extra reaches the index. A project owner is representable; nothing here decides what one means. */
export function ownerIssues(raw: unknown): ValidationIssue[] {
  const invalid: ValidationIssue[] = [{ code: 'invalid_shape', path: 'owner' }];
  if (!isRecord(raw)) return invalid;
  const keys = Object.keys(raw);
  switch (raw.kind) {
    case 'library': return keys.length === 1 ? [] : invalid;
    case 'agent': return keys.length === 2 && isCatalogId(raw.agentId) ? [] : invalid;
    case 'project': return keys.length === 2 && isCatalogId(raw.projectId) ? [] : invalid;
    default: return invalid;
  }
}

/**
 * Ids and short names only, so provenance can't carry a path or a value. Copies
 * come only from a user's copy action, and built-ins only from the installer.
 */
export function sourceIssues(raw: unknown, allowBuiltin = false): ValidationIssue[] {
  const invalid: ValidationIssue[] = [{ code: 'invalid_shape', path: 'source' }];
  if (!isRecord(raw)) return invalid;
  switch (raw.kind) {
    case 'user':
      return Object.keys(raw).length === 1 ? [] : invalid;
    case 'builtin':
      return allowBuiltin && Object.keys(raw).length === 2 && isCatalogId(raw.builtinId) ? [] : invalid;
    case 'import': {
      const known = Object.keys(raw).every((key) => ['kind', 'from', 'projectId', 'nativeName'].includes(key));
      const from = raw.from === 'native-mcp' || raw.from === 'project-skill' || raw.from === 'persona' || raw.from === 'native-subagent' || raw.from === 'project-defaults';
      const ids = (raw.projectId === undefined || isCatalogId(raw.projectId)) && (raw.nativeName === undefined || isCatalogId(raw.nativeName));
      return known && from && ids ? [] : invalid;
    }
    case 'plugin': {
      // A manifest plugin id (lower case, digits and dashes), a project id and its key.
      const known = Object.keys(raw).length === 4 && ['kind', 'pluginId', 'projectId', 'key'].every((key) => key in raw);
      const ids = typeof raw.pluginId === 'string' && /^[a-z0-9-]+$/.test(raw.pluginId) && isCatalogId(raw.pluginId)
        && isCatalogId(raw.projectId) && isCatalogId(raw.key);
      return known && ids ? [] : invalid;
    }
    default:
      return invalid;
  }
}

const COMPOSITION_FIELDS = [
  'template', 'entries', 'excludedEntryIds', 'subagents', 'excludedSubagentEntryIds',
  'additions', 'removals', 'floors', 'keepMarkers', 'authorityApprovals',
] as const;

/** Exactly one of `baseEntryId` and `localId`, and a source that fits it. */
function validateEntryIdentity(raw: Record<string, unknown>, at: string, issues: Issues): boolean {
  const base = raw.baseEntryId !== undefined;
  const local = raw.localId !== undefined;
  if (base === local) {
    issues.add('invalid_entry', at);
    return false;
  }
  if (!isCatalogId(base ? raw.baseEntryId : raw.localId)) issues.add('invalid_identifier', at);
  return base;
}

function validateEntries(raw: unknown, path: string, assetField: 'blockId' | 'subagentId', issues: Issues): Array<InstanceEntry | InstanceSubagent> {
  if (!Array.isArray(raw)) {
    issues.add('invalid_shape', path);
    return [];
  }
  const seen = new Set<string>();
  return raw.flatMap((item: unknown, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(item) || !isRecord(item.source)) {
      issues.add('invalid_entry', at);
      return [];
    }
    issues.closed(item, ['baseEntryId', 'localId', 'source'], `${at}.`);
    const isBase = validateEntryIdentity(item, at, issues);
    const key = `${isBase ? 'base' : 'local'}:${String(isBase ? item.baseEntryId : item.localId)}`;
    if (seen.has(key)) issues.add('duplicate_reference', at);
    seen.add(key);

    const source = item.source;
    const asset = source[assetField];
    const allowed = source.kind === 'fork' ? ['kind', assetField, 'forkedFrom'] : ['kind', assetField];
    issues.closed(source, allowed, `${at}.source.`);
    if (source.kind === 'follow') {
      // A base entry takes its asset from the template. A local one has to name what it follows.
      if (isBase ? asset !== undefined : !isAssetId(asset)) issues.add('invalid_entry', `${at}.source`);
    } else if (source.kind === 'fork') {
      const from = source.forkedFrom;
      if (!isAssetId(asset) || !isRecord(from) || !isAssetId(from.assetId) || !isRevision(from.revision)) issues.add('invalid_entry', `${at}.source`);
      else issues.closed(from, ['assetId', 'revision'], `${at}.source.forkedFrom.`);
    } else if (source.kind === 'local') {
      if (isBase || !isAssetId(asset)) issues.add('invalid_entry', `${at}.source`);
    } else {
      issues.add('invalid_entry', `${at}.source`);
    }
    return [item as unknown as InstanceEntry | InstanceSubagent];
  });
}

function validateRevisionMap(raw: unknown, path: string, issues: Issues): Record<string, number> {
  if (!isRecord(raw)) {
    issues.add('invalid_shape', path);
    return {};
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!isAssetId(key)) issues.add('invalid_identifier', `${path}.${safeKey(key)}`);
    if (!isRevision(value)) issues.add('invalid_revision', `${path}.${safeKey(key)}`);
  }
  return raw as Record<string, number>;
}

function validateApprovals(raw: unknown, issues: Issues): CompositionInput['authorityApprovals'] {
  if (!isRecord(raw)) {
    issues.add('invalid_shape', 'authorityApprovals');
    return {};
  }
  for (const [key, value] of Object.entries(raw)) {
    const at = `authorityApprovals.${safeKey(key)}`;
    if (!isAssetId(key)) issues.add('invalid_identifier', at);
    if (!isRecord(value) || !isRevision(value.revision) || typeof value.contentHash !== 'string' || !CONTENT_HASH_RE.test(value.contentHash)) issues.add('invalid_revision', at);
    else issues.closed(value, ['revision', 'contentHash'], `${at}.`);
  }
  return raw as CompositionInput['authorityApprovals'];
}

function validateIdList(raw: unknown, path: string, isValid: (id: unknown) => boolean, issues: Issues): string[] {
  if (!Array.isArray(raw) || raw.some((id) => !isValid(id))) {
    issues.add('invalid_identifier', path);
    return [];
  }
  if (new Set(raw).size !== raw.length) issues.add('duplicate_reference', path);
  return raw as string[];
}

/** Closed, so nothing about a session, wire, worktree, helper or launch setting can be tied to a composition. */
export function validateComposition(raw: unknown): { ok: true; composition: CompositionInput } | { ok: false; issues: ValidationIssue[] } {
  const issues = new Issues();
  if (!isRecord(raw)) return { ok: false, issues: [{ code: 'invalid_shape', path: '' }] };
  issues.closed(raw, COMPOSITION_FIELDS, '');
  const { template } = raw;
  if (template !== null) {
    if (!isRecord(template) || !isAssetId(template.templateId) || !isRevision(template.acceptedRevision)) issues.add('invalid_identifier', 'template');
    else issues.closed(template, ['templateId', 'acceptedRevision'], 'template.');
  }
  const composition: CompositionInput = {
    template: template as CompositionInput['template'],
    entries: validateEntries(raw.entries, 'entries', 'blockId', issues) as InstanceEntry[],
    excludedEntryIds: validateIdList(raw.excludedEntryIds, 'excludedEntryIds', isCatalogId, issues),
    subagents: validateEntries(raw.subagents, 'subagents', 'subagentId', issues) as InstanceSubagent[],
    excludedSubagentEntryIds: validateIdList(raw.excludedSubagentEntryIds, 'excludedSubagentEntryIds', isCatalogId, issues),
    additions: validateIdList(raw.additions, 'additions', isAssetId, issues),
    removals: validateIdList(raw.removals, 'removals', isAssetId, issues),
    floors: validateRevisionMap(raw.floors, 'floors', issues),
    keepMarkers: validateRevisionMap(raw.keepMarkers, 'keepMarkers', issues),
    authorityApprovals: validateApprovals(raw.authorityApprovals, issues),
  };
  return issues.list.length > 0 ? { ok: false, issues: issues.list } : { ok: true, composition };
}

// ── Native adoption ──────────────────────────────────────────────────────

const NATIVE_REFERENCE_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

function nativeTransport(raw: Record<string, unknown>): McpAssetPayload['transport'] | null {
  switch (raw.type) {
    case undefined: return raw.url !== undefined ? 'http' : 'stdio';
    case 'stdio': return 'stdio';
    case 'sse': return 'sse';
    case 'http':
    case 'streamable-http': return 'http';
    default: return null;
  }
}

/**
 * An MCP entry from a native config file, as a payload. A value that names the
 * same variable (`GITHUB_TOKEN: "${GITHUB_TOKEN}"`) becomes the forwarded
 * reference every provider supports. A secret-named literal, a reference under a
 * different name and any other field block adoption: nothing is dropped quietly,
 * so nothing that matters for sign-in is lost or copied.
 */
export function adoptNativeMcpServer(serverKey: string, raw: unknown): PayloadValidation<'mcp'> {
  if (!isRecord(raw)) return { ok: false, issues: [{ code: 'invalid_shape', path: '' }] };
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(raw)) {
    if (['command', 'args', 'env', 'env_vars', 'type', 'url'].includes(key)) continue;
    issues.push({ code: isSecretKey(key) || key === 'headers' ? 'secret_value' : 'unsupported_native_field', path: safeKey(key) });
  }

  if (raw.env !== undefined && !isRecord(raw.env)) issues.push({ code: 'invalid_shape', path: 'env' });
  if (raw.env_vars !== undefined && !Array.isArray(raw.env_vars)) issues.push({ code: 'invalid_shape', path: 'env_vars' });

  const env: Record<string, string> = {};
  const envVars = new Set(Array.isArray(raw.env_vars) ? raw.env_vars as string[] : []);
  for (const [name, value] of Object.entries(isRecord(raw.env) ? raw.env : {})) {
    const reference = typeof value === 'string' ? NATIVE_REFERENCE_RE.exec(value) : null;
    if (reference && reference[1] === name) envVars.add(name);
    else if (reference) issues.push({ code: 'secret_value', path: `env.${safeKey(name)}` });
    else env[name] = value as string;
  }

  const transport = nativeTransport(raw);
  if (!transport) issues.push({ code: 'unsupported_native_field', path: 'type' });
  const result = validatePayload('mcp', {
    serverKey,
    transport,
    ...(raw.command !== undefined && { command: raw.command }),
    ...(raw.args !== undefined && { args: raw.args }),
    ...(raw.url !== undefined && { url: raw.url }),
    ...(Object.keys(env).length > 0 && { env }),
    ...(envVars.size > 0 && { envVars: [...envVars] }),
  });
  if (result.ok === false) return { ok: false, issues: [...issues, ...result.issues] };
  return issues.length > 0 ? { ok: false, issues } : result;
}

// ── Redaction ────────────────────────────────────────────────────────────

/** A URL for showing: no userinfo, no query. */
function redactedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return redactSecretValues(`${parsed.protocol}//${parsed.host}${parsed.pathname}`);
  } catch {
    // telemetry-exempt: not parseable, so nothing in it can be shown
    return REDACTED;
  }
}

/** A revision for previews and diffs. Env values never appear, and text is scrubbed even though saves refuse secrets. */
export function previewPayload(kind: AssetKind, payload: AssetPayload): AssetPreview {
  switch (kind) {
    case 'mcp': {
      const mcp = payload as McpAssetPayload;
      return {
        kind,
        serverKey: mcp.serverKey,
        transport: mcp.transport,
        ...(mcp.command && { command: redactSecretValues(mcp.command) }),
        ...(mcp.args && { args: mcp.args.map(redactSecretValues) }),
        ...(mcp.url && { url: redactedUrl(mcp.url) }),
        envNames: Object.keys(mcp.env ?? {}).sort(),
        envVars: [...(mcp.envVars ?? [])].sort(),
        ...(mcp.auth && { auth: mcp.auth }),
        ...(mcp.upstream && { upstream: mcp.upstream }),
      };
    }
    case 'skill': {
      const skill = payload as SkillAssetPayload;
      return {
        kind,
        skillName: skill.skillName,
        files: skill.files.map((file) => ({
          path: file.path,
          bytes: decodedSize(file),
          ...(file.encoding !== 'base64' && { text: redactSecretValues(file.content) }),
        })),
      };
    }
    case 'block':
      return { kind, text: redactSecretValues((payload as BlockAssetPayload).content) };
    case 'subagent': {
      const subagent = payload as SubagentAssetPayload;
      return {
        kind,
        agentName: subagent.agentName,
        description: redactSecretValues(subagent.description),
        blocks: subagent.blocks,
        skills: subagent.skills,
        mcps: subagent.mcps,
        providerFields: Object.fromEntries(
          Object.entries(subagent.provider ?? {}).map(([id, section]) => [id, Object.keys(section).sort()]),
        ),
        toolFields: toolFieldsOf(subagent.provider),
      };
    }
    case 'template':
      return { kind, ...(payload as TemplateAssetPayload) };
  }
}

/** Provenance reduced to its kind: an import's project and native name aren't an agent's business. */
export function agentMetadata(entry: CatalogEntry): AssetAgentMetadata {
  return {
    id: entry.id,
    kind: entry.kind,
    name: redactSecretValues(entry.name),
    headRevision: entry.headRevision,
    ownerKind: entry.owner.kind,
    sourceKind: entry.source.kind,
  };
}
