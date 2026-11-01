import * as path from 'path';
import type { PermissionRequest, ProviderConfig } from '@github/copilot-sdk';
import type { ChatErrorCode, PermissionOption, TokenUsage, ToolCallContent, ToolCallLocation, ToolKind } from '../../../shared/chat/events';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const TOOL_KINDS: Record<string, ToolKind> = {
  bash: 'execute', powershell: 'execute', read_bash: 'execute', write_bash: 'execute', stop_bash: 'execute', read_powershell: 'execute', write_powershell: 'execute', stop_powershell: 'execute',
  view: 'read',
  edit: 'edit', create: 'edit', str_replace: 'edit', apply_patch: 'edit',
  grep: 'search', glob: 'search', rg: 'search', lsp: 'search',
  web_fetch: 'fetch', web_search: 'fetch',
  exit_plan_mode: 'switch_mode',
  update_todo: 'think', sql: 'other',
};

export function copilotToolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'other';
}

function argPath(args: Obj): string | undefined {
  return str(args.path) ?? str(args.file_path) ?? str(args.fileName);
}

export function copilotToolLocations(args: unknown): ToolCallLocation[] | undefined {
  const p = isObj(args) ? argPath(args) : undefined;
  return p ? [{ path: p }] : undefined;
}

/** A tool card title. Copilot's own `toolTitle` is generic ("Running command"), so what the call says it does comes first. */
export function copilotToolTitle(name: string, args: unknown, toolTitle: string | undefined, cwd: string): string {
  const input = isObj(args) ? args : {};
  const p = argPath(input);
  const shown = p && path.isAbsolute(p) && cwd ? path.relative(cwd, p) || p : p;
  switch (name) {
    case 'view': return shown ? `Read ${shown}` : 'Read';
    case 'edit': case 'str_replace': return shown ? `Edit ${shown}` : 'Edit';
    case 'create': return shown ? `Write ${shown}` : 'Write';
    case 'grep': case 'rg': return input.pattern ? `Search for ${String(input.pattern)}` : 'Search';
    case 'glob': return input.pattern ? `Find ${String(input.pattern)}` : 'Find files';
    case 'web_fetch': return str(input.url) ? `Fetch ${String(input.url)}` : 'Fetch';
    default: return str(input.description) ?? str(input.command) ?? toolTitle ?? name;
  }
}

/** What a finished call shows: its terminal output for a shell, otherwise its result text. */
export function copilotToolContent(name: string, args: unknown, output: string | undefined, exitCode: number | undefined, cwd: string): ToolCallContent[] | undefined {
  if (copilotToolKind(name) === 'execute' && output !== undefined) {
    const command = isObj(args) ? str(args.command) : undefined;
    return [{ type: 'terminal', ...(command && { command }), cwd, output, ...(exitCode !== undefined && { exitCode }) }];
  }
  return output ? [{ type: 'text', text: output }] : undefined;
}

// ── Permissions ─────────────────────────────────────────────────────────────

export const COPILOT_OPTION_ALLOW = 'allow';
export const COPILOT_OPTION_ALLOW_SESSION = 'allow_session';
export const COPILOT_OPTION_DENY = 'deny';

export function copilotPermissionOptions(request: PermissionRequest): PermissionOption[] {
  const canRemember = 'canOfferSessionApproval' in request && request.canOfferSessionApproval === true;
  return [
    { optionId: COPILOT_OPTION_ALLOW, kind: 'allow_once', label: 'Allow' },
    ...(canRemember ? [{ optionId: COPILOT_OPTION_ALLOW_SESSION, kind: 'allow_always' as const, label: "Allow and don't ask again", scope: 'This session' }] : []),
    { optionId: COPILOT_OPTION_DENY, kind: 'reject_once', label: 'Deny' },
  ];
}

export interface CopilotPermissionView {
  title: string;
  description?: string;
  toolName: string;
  content?: ToolCallContent[];
}

/** How a typed permission request reads in the approval card. */
export function copilotPermissionView(request: PermissionRequest): CopilotPermissionView {
  switch (request.kind) {
    case 'shell':
      return { title: request.intention || 'Run command', description: request.fullCommandText, toolName: 'bash' };
    case 'write':
      return {
        title: `Write ${request.fileName}`,
        description: request.intention,
        toolName: 'write',
        content: [{ type: 'diff', path: request.fileName, ...(request.newFileContents !== undefined && { newText: request.newFileContents }), unifiedDiff: request.diff }],
      };
    case 'read':
      return { title: `Read ${request.path}`, description: request.intention, toolName: 'read' };
    case 'url':
      return { title: `Fetch ${request.url}`, description: request.intention, toolName: 'url' };
    case 'mcp':
      return { title: request.toolTitle || request.toolName, description: request.serverDisplayName ?? request.serverName, toolName: request.toolName };
    case 'custom-tool':
      return { title: request.toolName, description: request.toolDescription, toolName: request.toolName };
    default:
      return { title: `Copilot asks to use ${request.kind}`, toolName: request.kind };
  }
}

// ── Errors and usage ────────────────────────────────────────────────────────

/** The contract code for a `session.error`. The "not logged in" message has no code of its own (docs/copilot-sdk-driver.md "Fallback"). */
export function copilotErrorCode(data: { errorType?: string; statusCode?: number; message?: string }): ChatErrorCode {
  const status = data.statusCode;
  if (status === 401 || status === 403 || /no github oauth token|not authenticated|not logged in/i.test(data.message ?? '')) return 'auth_required';
  if (status === 429 || /rate.?limit|quota/i.test(data.errorType ?? '')) return 'rate_limited';
  if (/context/i.test(data.errorType ?? '')) return 'context_overflow';
  return 'unknown';
}

/** `assistant.usage` for one model call as contract tokens: `input` already includes cache reads and writes. */
export function copilotTokens(u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }): TokenUsage {
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  return {
    input,
    output,
    ...(u.cacheReadTokens && { cachedInput: u.cacheReadTokens }),
    ...(u.cacheWriteTokens && { cacheWrite: u.cacheWriteTokens }),
    ...(u.reasoningTokens && { reasoning: u.reasoningTokens }),
    total: input + output,
  };
}

export function addTokens(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return b;
  const sum = (x?: number, y?: number) => ((x ?? 0) + (y ?? 0)) || undefined;
  return {
    input: sum(a.input, b.input),
    output: sum(a.output, b.output),
    cachedInput: sum(a.cachedInput, b.cachedInput),
    cacheWrite: sum(a.cacheWrite, b.cacheWrite),
    reasoning: sum(a.reasoning, b.reasoning),
    total: sum(a.total, b.total),
  };
}

// ── Your own model key ──────────────────────────────────────────────────────

const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined =>
  (allowed as readonly string[]).includes(value ?? '') ? value as T : undefined;

function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value);
  return value && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `COPILOT_PROVIDER_HEADERS`: "Name: Value" pairs, split by line breaks or a literal "\\n". */
function parseProviderHeaders(value: string | undefined): Record<string, string> | undefined {
  const pairs = (value ?? '').split(/\r?\n|\\n/).flatMap((line): Array<[string, string]> => {
    const colon = line.indexOf(':');
    const name = line.slice(0, Math.max(colon, 0)).trim();
    return name ? [[name, line.slice(colon + 1).trim()]] : [];
  });
  return pairs.length ? Object.fromEntries(pairs) : undefined;
}

/**
 * The session's `provider` from the variables `copilot help environment`
 * documents. The CLI view and ACP honor them, but `--headless` ignores them and
 * still wants a GitHub login, so the driver has to pass them on. Only the base
 * URL turns a provider on, as in the CLI.
 */
export function copilotProviderFromEnv(env: Record<string, string | undefined>): ProviderConfig | undefined {
  const baseUrl = env.COPILOT_PROVIDER_BASE_URL;
  if (!baseUrl) return undefined;
  const type = oneOf(env.COPILOT_PROVIDER_TYPE, ['openai', 'azure', 'anthropic'] as const);
  const wireApi = oneOf(env.COPILOT_PROVIDER_WIRE_API, ['completions', 'responses'] as const);
  const transport = oneOf(env.COPILOT_PROVIDER_TRANSPORT, ['http', 'websockets'] as const);
  const headers = parseProviderHeaders(env.COPILOT_PROVIDER_HEADERS);
  const maxPromptTokens = positiveInt(env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS);
  const maxOutputTokens = positiveInt(env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS);
  return {
    baseUrl,
    ...(type && { type }),
    ...(wireApi && { wireApi }),
    ...(transport && { transport }),
    ...(env.COPILOT_PROVIDER_API_KEY && { apiKey: env.COPILOT_PROVIDER_API_KEY }),
    ...(env.COPILOT_PROVIDER_API_KEY_COMMAND && { apiKeyCommand: env.COPILOT_PROVIDER_API_KEY_COMMAND }),
    ...(env.COPILOT_PROVIDER_BEARER_TOKEN && { bearerToken: env.COPILOT_PROVIDER_BEARER_TOKEN }),
    ...(env.COPILOT_PROVIDER_AZURE_API_VERSION && { azure: { apiVersion: env.COPILOT_PROVIDER_AZURE_API_VERSION } }),
    ...(headers && { headers }),
    ...(env.COPILOT_PROVIDER_MODEL_ID && { modelId: env.COPILOT_PROVIDER_MODEL_ID }),
    ...(env.COPILOT_PROVIDER_WIRE_MODEL && { wireModel: env.COPILOT_PROVIDER_WIRE_MODEL }),
    ...(maxPromptTokens && { maxPromptTokens }),
    ...(maxOutputTokens && { maxOutputTokens }),
  };
}
