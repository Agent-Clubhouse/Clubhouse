import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  OrchestratorConventions,
  ProviderCapabilities,
  PasteSubmitTiming,
  SpawnOpts,
  SpawnCommandResult,
  HeadlessOpts,
  HeadlessCommandResult,
  NormalizedHookEvent,
  StructuredAdapter,
  HookCapable,
  HeadlessCapable,
  StructuredCapable,
} from './types';
import type { McpServerDef } from '../../shared/types';
import { BaseProvider } from './base-provider';
import { AcpAdapter } from './adapters';
import { homePath, parseModelChoicesFromHelp } from './shared';
import { isClubhouseHookEntry } from '../services/config-pipeline';

const TOOL_VERBS: Record<string, string> = {
  shell: 'Running command',
  edit: 'Editing file',
  read: 'Reading file',
  search: 'Searching code',
  agent: 'Running agent',
};

const FALLBACK_MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-6[1m]', label: 'Claude Opus 4.6 (1M)' },
  { id: 'claude-sonnet-4-6[1m]', label: 'Claude Sonnet 4.6 (1M)' },
  { id: 'gpt-5', label: 'GPT 5' },
  { id: 'gpt-5-mini', label: 'GPT 5 Mini' },
];

const COPILOT_MODEL_CHOICES_PATTERN = /--model\s+<model>\s+.*?\(choices:\s*([\s\S]*?)\)/;

const DEFAULT_DURABLE_PERMISSIONS = ['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = ['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)', 'read', 'edit', 'search'];

const EVENT_NAME_MAP: Record<string, NormalizedHookEvent['kind']> = {
  preToolUse: 'pre_tool',
  postToolUse: 'post_tool',
  errorOccurred: 'tool_error',
  sessionEnd: 'stop',
};

export class CopilotCliProvider extends BaseProvider implements HookCapable, HeadlessCapable, StructuredCapable {
  readonly id = 'copilot-cli' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly shortName = 'GHCP';
  readonly badge = 'Beta';

  readonly conventions: OrchestratorConventions = {
    configDir: '.github',
    localInstructionsFile: 'copilot-instructions.md',
    legacyInstructionsFile: 'copilot-instructions.md',
    mcpConfigFile: '.github/mcp.json',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'hooks/hooks.json',
  };

  // ── BaseProvider configuration ──────────────────────────────────────────

  protected readonly binaryNames = ['copilot'];

  protected getExtraBinaryPaths(): string[] {
    const paths = [
      homePath('.local', 'bin', 'copilot'),
    ];
    if (process.platform === 'win32') {
      paths.push(
        homePath('AppData', 'Roaming', 'npm', 'copilot.cmd'),
        homePath('AppData', 'Roaming', 'npm', 'copilot'),
      );
    } else {
      paths.push('/usr/local/bin/copilot', '/opt/homebrew/bin/copilot');
    }
    return paths;
  }

  protected getInstructionsPath(worktreePath: string): string {
    return path.join(worktreePath, '.github', 'copilot-instructions.md');
  }

  protected readonly toolVerbs = TOOL_VERBS;
  protected readonly durablePermissions = DEFAULT_DURABLE_PERMISSIONS;
  protected readonly quickPermissions = DEFAULT_QUICK_PERMISSIONS;
  protected readonly fallbackModelOptions = FALLBACK_MODEL_OPTIONS;
  protected readonly configEnvKeys = ['GH_HOST', 'GH_TOKEN'];

  protected readonly modelFetchConfig = {
    args: ['--help'],
    parser: (help: string) => parseModelChoicesFromHelp(help, COPILOT_MODEL_CHOICES_PATTERN),
  };

  // ── Paste timing ────────────────────────────────────────────────────────

  /**
   * Copilot CLI processes bracketed paste more slowly than Claude Code.
   * Use longer delays to give it time to render the paste preview before
   * sending Enter keystrokes.
   *
   * The latest GHCP beta introduced additional latency in paste handling,
   * so these values include extra headroom to avoid race conditions where
   * Enter arrives before the paste preview is ready.
   */
  override getPasteSubmitTiming(): PasteSubmitTiming {
    return {
      initialDelayMs: 1200,
      retryDelayMs: 600,
      finalCheckDelayMs: 400,
      chunkSize: 256,
      chunkDelayMs: 120,
      postEndMarkerDelayMs: 300,
    };
  }

  // ── Core interface ──────────────────────────────────────────────────────

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      structuredOutput: false,
      hooks: true,
      sessionResume: true,
      permissions: true,
      structuredMode: true,
      structuredProtocol: 'acp',
    };
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<SpawnCommandResult> {
    const binary = this.findBinary();
    const args: string[] = [];

    // Session resume: --resume <id> for specific session, --continue for most recent.
    // Note: Copilot CLI does not support resume in prompt mode (-p), so resume
    // flags are only appended for interactive (non-prompt) sessions.
    if (opts.resume && !(opts.mission || opts.systemPrompt)) {
      if (opts.sessionId) {
        args.push('--resume', opts.sessionId);
      } else {
        args.push('--continue');
      }
    }

    if (opts.freeAgentMode) {
      args.push('--yolo', '--autopilot');
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      for (const tool of opts.allowedTools) {
        args.push('--allow-tool', tool);
      }
    }

    if (opts.mission || opts.systemPrompt) {
      const parts: string[] = [];
      if (opts.systemPrompt) parts.push(opts.systemPrompt);
      if (opts.mission) parts.push(opts.mission);
      args.push('-p', parts.join('\n\n'));
    }

    return { binary, args };
  }

  // ── MCP CLI injection ──────────────────────────────────────────────────

  /**
   * Copilot CLI reads MCP config from ~/.copilot/mcp-config.json, not from
   * a project-level config file. Use --additional-mcp-config to inject the
   * Clubhouse MCP server for this session without modifying user-level config.
   */
  buildMcpArgs(serverDef: McpServerDef): string[] {
    const config = JSON.stringify({ mcpServers: { clubhouse: serverDef } });
    return ['--additional-mcp-config', config];
  }

  // ── StructuredCapable ───────────────────────────────────────────────────

  createStructuredAdapter(_opts?: { resume?: boolean }): StructuredAdapter {
    return new AcpAdapter({
      binary: this.findBinary(),
      args: ['--acp', '--stdio'],
      toolVerbs: TOOL_VERBS,
    });
  }

  // ── HookCapable ─────────────────────────────────────────────────────────

  async writeHooksConfig(cwd: string, hookUrl: string): Promise<void> {
    const makeCurl = (event: string) =>
      process.platform === 'win32'
        ? `curl -s -X POST ${hookUrl}/%CLUBHOUSE_AGENT_ID%/${event} -H "Content-Type: application/json" -H "X-Clubhouse-Nonce: %CLUBHOUSE_HOOK_NONCE%" -d @- || (exit /b 0)`
        : `cat | curl -s -X POST ${hookUrl}/\${CLUBHOUSE_AGENT_ID}/${event} -H 'Content-Type: application/json' -H "X-Clubhouse-Nonce: \${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true`;

    const ourHooks: Record<string, unknown[]> = {
      preToolUse: [{ type: 'command', bash: makeCurl('preToolUse'), timeoutSec: 5 }],
      postToolUse: [{ type: 'command', bash: makeCurl('postToolUse'), timeoutSec: 5 }],
      errorOccurred: [{ type: 'command', bash: makeCurl('errorOccurred'), timeoutSec: 5 }],
    };

    const githubDir = path.join(cwd, '.github');
    const hooksDir = path.join(githubDir, 'hooks');
    await fsp.mkdir(hooksDir, { recursive: true });

    const settingsPath = path.join(hooksDir, 'hooks.json');

    let existing: Record<string, unknown> = { version: 1 };
    try {
      existing = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
    } catch {
      // No existing file
    }

    // Merge per-event key: preserve user hooks, replace stale Clubhouse entries
    const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>;
    const mergedHooks: Record<string, unknown[]> = { ...existingHooks };

    for (const [eventKey, ourEntries] of Object.entries(ourHooks)) {
      const current = mergedHooks[eventKey] || [];
      const userEntries = current.filter(e => !isClubhouseHookEntry(e));
      mergedHooks[eventKey] = [...userEntries, ...ourEntries];
    }

    await fsp.writeFile(settingsPath, JSON.stringify({ ...existing, hooks: mergedHooks }, null, 2), 'utf-8');
  }

  parseHookEvent(raw: unknown): NormalizedHookEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const eventName = (obj.hook_event_name as string) || '';
    const kind = EVENT_NAME_MAP[eventName];
    if (!kind) return null;

    // Copilot sends camelCase (toolName, toolArgs) in hook stdin
    const toolName = (obj.tool_name ?? obj.toolName) as string | undefined;
    const rawInput = obj.tool_input ?? (typeof obj.toolArgs === 'string' ? JSON.parse(obj.toolArgs as string) : obj.toolArgs);

    return {
      kind,
      toolName,
      toolInput: rawInput as Record<string, unknown> | undefined,
      message: obj.message as string | undefined,
    };
  }

  // ── HeadlessCapable ─────────────────────────────────────────────────────

  async buildHeadlessCommand(opts: HeadlessOpts): Promise<HeadlessCommandResult | null> {
    if (!opts.mission) return null;

    const binary = this.findBinary();
    const parts: string[] = [];
    if (opts.systemPrompt) parts.push(opts.systemPrompt);
    parts.push(opts.mission);
    const args = ['-p', parts.join('\n\n'), '--allow-all', '--silent'];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args, outputKind: 'text' };
  }
}
