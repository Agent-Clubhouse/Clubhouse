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
import { parsePersonaFile } from '../../../shared/persona-pattern';
import type {
  AgentPresetPayload,
  AssetAgentMetadata,
  AssetKind,
  AssetPayload,
  AssetPayloadByKind,
  AssetPreview,
  AssetProjection,
  CatalogEntry,
  CompositionInput,
  InstructionAssetPayload,
  McpAssetPayload,
  PresetOperationalDefaults,
  SkillAssetPayload,
  SkillFile,
  UpstreamPackage,
  ValidationCode,
  ValidationIssue,
} from '../../../shared/asset-catalog-types';
import { containsSecretToken, isSecretKey, redactSecretValues, REDACTED } from '../../telemetry/diag-redaction';

export const MAX_INSTRUCTION_BYTES = 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_SKILL_FILES = 500;

const MAX_NAME_CHARS = 120;
const MAX_SKILL_PATH_CHARS = 200;
const SKILL_ENTRYPOINT = 'SKILL.md';

const OBJECT_KEY_TRAPS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9][\w.:-]{0,127}$/;
/** An asset id is also a directory name, so it has to be a safe one on every platform. */
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SERVER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const PATH_ILLEGAL_RE = /[<>:"|?*\\/]/;
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Clubhouse's own: its MCP bridge, its skills, and the variables it sets. Only a built-in may project here. */
const RESERVED_NAME_RE = /^clubhouse(?:[-_.].*)?$/i;
const RESERVED_ENV_RE = /^CLUBHOUSE_/i;

/** Files that hold credentials by convention. A skill bundle never carries them. */
const CREDENTIAL_FILE_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|.*\.(?:pem|key|p12|pfx))$/i;

/** Launch settings, under the spellings they go by. Separately coded so a preset's refusal says why. */
const FORBIDDEN_PRESET_FIELDS = new Set([
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

/** An agent, run, project or built-in id: only ever a key or a value in the index. */
export function isCatalogId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value) && !OBJECT_KEY_TRAPS.has(value);
}

export function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && ASSET_ID_RE.test(value) && !WINDOWS_DEVICE_RE.test(value) && !OBJECT_KEY_TRAPS.has(value);
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

function checkArgs(args: string[], issues: Issues): void {
  args.forEach((arg, index) => {
    const flag = SECRET_FLAG_RE.exec(arg);
    const value = flag?.[2] ?? (args[index + 1]?.startsWith('-') ? undefined : args[index + 1]);
    const literal = !!flag && value !== undefined && isSecretLiteral(flag[1], value);
    if (literal || hasSecretValue(arg)) issues.add('secret_value', `args[${index}]`);
  });
}

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
    if (isSecretKey(key)) issues.add('secret_value', 'url');
  }
  if (containsSecretToken(url)) issues.add('secret_value', 'url');
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
  if (typeof serverKey !== 'string' || !SERVER_KEY_RE.test(serverKey) || OBJECT_KEY_TRAPS.has(serverKey)) {
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
    if (!ENV_NAME_RE.test(name) || OBJECT_KEY_TRAPS.has(name)) issues.add('invalid_identifier', at);
    else if (RESERVED_ENV_RE.test(name)) issues.add('reserved_namespace', at);
    if (typeof value !== 'string') {
      issues.add('invalid_shape', at);
      continue;
    }
    if (isSecretLiteral(name, value) || hasSecretValue(value)) issues.add('secret_value', at);
    env[name] = value;
  }

  const envVars = stringList(raw.envVars, 'envVars', issues);
  envVars.forEach((name, index) => {
    if (!ENV_NAME_RE.test(name) || OBJECT_KEY_TRAPS.has(name)) issues.add('invalid_identifier', `envVars[${index}]`);
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

function isSafePathSegment(segment: string): boolean {
  return !!segment
    && segment !== '.'
    && segment !== '..'
    && !PATH_ILLEGAL_RE.test(segment)
    && !CONTROL_CHARS_RE.test(segment)
    && !WINDOWS_DEVICE_RE.test(segment)
    && !/[. ]$/.test(segment);
}

function decodedSize(file: SkillFile): number {
  return file.encoding === 'base64' ? Buffer.from(file.content, 'base64').byteLength : Buffer.byteLength(file.content, 'utf8');
}

function isCanonicalBase64(content: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(content) && content.length % 4 === 0;
}

function validateSkill(raw: Record<string, unknown>, issues: Issues, reservedAllowed: boolean): SkillAssetPayload | null {
  issues.closed(raw, ['skillName', 'files'], '');
  const { skillName, files } = raw;
  if (typeof skillName !== 'string' || !isSafePathSegment(skillName) || skillName.length > 64 || OBJECT_KEY_TRAPS.has(skillName)) {
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

// ── Instructions ─────────────────────────────────────────────────────────

function validateInstruction(raw: Record<string, unknown>, issues: Issues): InstructionAssetPayload | null {
  issues.closed(raw, ['content'], '');
  const { content } = raw;
  if (typeof content !== 'string' || !content.trim()) {
    issues.add('invalid_shape', 'content');
    return null;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_INSTRUCTION_BYTES) issues.add('too_large', 'content');
  if (containsSecretToken(content)) issues.add('secret_value', 'content');
  // Persona front matter carries model and orchestrator. An import splits them out, so a document can't smuggle them in.
  if (Object.keys(parsePersonaFile(content).settings).length > 0) issues.add('launch_settings_in_instruction', 'content');
  return { content };
}

// ── Presets ──────────────────────────────────────────────────────────────

const PRESET_FIELDS = ['instruction', 'skills', 'mcps', 'operationalDefaults'] as const;

function checkForbidden(raw: Record<string, unknown>, prefix: string, issues: Issues, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_PRESET_FIELDS.has(normalizedField(key))) issues.add('forbidden_preset_field', `${prefix}${safeKey(key)}`);
    else if (!allowed.includes(key)) issues.add('unknown_field', `${prefix}${safeKey(key)}`);
  }
}

function validateOperationalDefaults(raw: unknown, issues: Issues): PresetOperationalDefaults | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.add('invalid_operational_default', 'operationalDefaults');
    return undefined;
  }
  const { agentAccess, ...policy } = raw;
  const known = ['orchestrate', 'access', 'control', 'maxHelpers', 'crossProjectHelpers', 'connectToDispatcher', 'autoHelpers'];
  checkForbidden(policy, 'operationalDefaults.', issues, known);
  const out: PresetOperationalDefaults = {};
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

function validatePreset(raw: Record<string, unknown>, issues: Issues): AgentPresetPayload | null {
  checkForbidden(raw, '', issues, [...PRESET_FIELDS, 'instructions', 'presets', 'preset']);
  if ('instructions' in raw) issues.add('invalid_instruction_cardinality', 'instructions');
  if ('presets' in raw || 'preset' in raw) issues.add('nested_preset', 'presets' in raw ? 'presets' : 'preset');
  const { instruction } = raw;
  if (!isAssetId(instruction)) issues.add('invalid_instruction_cardinality', 'instruction');
  const skills = stringList(raw.skills, 'skills', issues);
  const mcps = stringList(raw.mcps, 'mcps', issues);
  for (const [path, list] of [['skills', skills], ['mcps', mcps]] as const) {
    list.forEach((id, index) => {
      if (!isAssetId(id)) issues.add('invalid_identifier', `${path}[${index}]`);
    });
    if (new Set(list).size !== list.length) issues.add('duplicate_reference', path);
  }
  const operationalDefaults = validateOperationalDefaults(raw.operationalDefaults, issues);
  return {
    instruction: instruction as string,
    skills,
    mcps,
    ...(operationalDefaults && { operationalDefaults }),
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
    case 'instruction':
      return { kind };
    case 'preset': {
      const preset = payload as AgentPresetPayload;
      return {
        kind,
        instruction: preset.instruction,
        skills: preset.skills,
        mcps: preset.mcps,
        ...(preset.operationalDefaults && { operationalDefaults: preset.operationalDefaults }),
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
    case 'instruction': payload = validateInstruction(raw, issues); break;
    case 'preset': payload = validatePreset(raw, issues); break;
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

/** Ids and short names only, so provenance can't carry a path or a value. Copies come only from a user's copy action. */
export function sourceIssues(raw: unknown): ValidationIssue[] {
  const invalid: ValidationIssue[] = [{ code: 'invalid_shape', path: 'source' }];
  if (!isRecord(raw)) return invalid;
  switch (raw.kind) {
    case 'user':
      return Object.keys(raw).length === 1 ? [] : invalid;
    case 'builtin':
      return Object.keys(raw).length === 2 && isCatalogId(raw.builtinId) ? [] : invalid;
    case 'import': {
      const known = Object.keys(raw).every((key) => ['kind', 'from', 'projectId', 'nativeName'].includes(key));
      const from = raw.from === 'native-mcp' || raw.from === 'project-skill' || raw.from === 'persona';
      const ids = (raw.projectId === undefined || isCatalogId(raw.projectId)) && (raw.nativeName === undefined || isCatalogId(raw.nativeName));
      return known && from && ids ? [] : invalid;
    }
    default:
      return invalid;
  }
}

const COMPOSITION_FIELDS = ['basePresetId', 'additions', 'removals', 'instructionAssetId'] as const;

/** Closed, so nothing about a session, wire, worktree, helper or launch setting can be tied to a composition. */
export function validateComposition(raw: unknown): { ok: true; composition: CompositionInput } | { ok: false; issues: ValidationIssue[] } {
  const issues = new Issues();
  if (!isRecord(raw)) return { ok: false, issues: [{ code: 'invalid_shape', path: '' }] };
  issues.closed(raw, COMPOSITION_FIELDS, '');
  const { basePresetId, instructionAssetId } = raw;
  if (basePresetId !== null && !isAssetId(basePresetId)) issues.add('invalid_identifier', 'basePresetId');
  if (instructionAssetId !== null && !isAssetId(instructionAssetId)) issues.add('invalid_identifier', 'instructionAssetId');
  const lists: Record<'additions' | 'removals', string[]> = { additions: [], removals: [] };
  for (const key of ['additions', 'removals'] as const) {
    const list = raw[key];
    if (!Array.isArray(list) || list.some((id) => !isAssetId(id))) {
      issues.add('invalid_identifier', key);
      continue;
    }
    if (new Set(list).size !== list.length) issues.add('duplicate_reference', key);
    lists[key] = list as string[];
  }
  if (issues.list.length > 0) return { ok: false, issues: issues.list };
  return {
    ok: true,
    composition: {
      basePresetId: basePresetId as string | null,
      additions: lists.additions,
      removals: lists.removals,
      instructionAssetId: instructionAssetId as string | null,
    },
  };
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
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
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
    case 'instruction':
      return { kind, text: redactSecretValues((payload as InstructionAssetPayload).content) };
    case 'preset':
      return { kind, ...(payload as AgentPresetPayload) };
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
