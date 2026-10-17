import {
  ACP_SCHEMA_VERSION,
  type InitializeResponse,
  type PermissionOptionKind,
} from './acp-schema';

/**
 * What an ACP-driven chat session can and can't do, so the UI can downgrade
 * (for example "Stop and send" instead of Steer). Built from the agent's
 * `initialize` response, then corrected by the agent's profile with facts the
 * handshake doesn't state (see copilot-acp.ts).
 */
export interface AcpDriverCapabilities {
  driver: 'acp';
  profile: string;
  agent: { name: string; title?: string; version?: string };
  protocolVersion: number;
  schemaVersion: string;

  /** `resume` restores context without replay; `load` replays history as updates; `none` can't reopen. */
  resume: 'resume' | 'load' | 'none';
  /** Stable v1 has no fork; the unstable one isn't driven here. */
  fork: false;
  listSessions: boolean;
  /** `session/list` returns other tools' sessions too, so filter by cwd. */
  listIsMachineWide: boolean;
  closeSession: boolean;
  deleteSession: boolean;

  cancel: true;
  /** Stable v1 has one `session/prompt` per turn: no mid-turn steering. */
  steer: false;
  /** Queueing happens in Clubhouse; the protocol has none. */
  queue: 'client';
  rewind: false;
  /** v1 has no structured plan-approval step; plans arrive as `plan` updates only. */
  planApproval: false;
  subagents: 'none' | 'unverified';

  modes: boolean;
  configOptions: boolean;
  /** Permission option kinds the agent sends; `'any'` when it hasn't said. */
  permissionOptionKinds: readonly PermissionOptionKind[] | 'any';
  /** `launch_only`: allow/deny rules exist only as CLI flags, never per session over ACP. */
  permissionRules: 'protocol' | 'launch_only';

  usage: {
    /** `usage_update` context-window fill. */
    context: boolean;
    /** Per-turn token totals on the prompt result (non-standard). */
    turnTokens: boolean;
    /** `usage_update.cost`. */
    cost: boolean;
  };

  prompt: { image: boolean; audio: boolean; embeddedContext: boolean };
  mcp: { stdio: true; http: boolean; sse: boolean };

  slashCommands: boolean;
  /** Commands that open TUI pickers don't work as prompt text. */
  interactiveSlashCommands: boolean;

  /** How the user logs in: a terminal command, the `authenticate` method, or nothing needed. */
  login: 'terminal' | 'agent' | 'none';
  /** The agent honours client fs/* methods. Clubhouse serves none today, so it's informational. */
  clientFs: boolean;

  /** Free-form notes on agent behaviour the UI or driver works around. */
  quirks: string[];
}

export function deriveAcpCapabilities(init: InitializeResponse, profile = 'generic'): AcpDriverCapabilities {
  const caps = init.agentCapabilities ?? {};
  const session = caps.sessionCapabilities ?? {};
  const prompt = caps.promptCapabilities ?? {};
  const mcp = caps.mcpCapabilities ?? {};

  return {
    driver: 'acp',
    profile,
    agent: {
      name: init.agentInfo?.name ?? 'unknown',
      ...(init.agentInfo?.title && { title: init.agentInfo.title }),
      ...(init.agentInfo?.version && { version: init.agentInfo.version }),
    },
    protocolVersion: init.protocolVersion,
    schemaVersion: ACP_SCHEMA_VERSION,
    resume: session.resume ? 'resume' : caps.loadSession ? 'load' : 'none',
    fork: false,
    listSessions: !!session.list,
    listIsMachineWide: false,
    closeSession: !!session.close,
    deleteSession: !!session.delete,
    cancel: true,
    steer: false,
    queue: 'client',
    rewind: false,
    planApproval: false,
    subagents: 'none',
    // Modes and config options are announced per session, not at initialize.
    // Assume both; the session state says what actually arrived.
    modes: true,
    configOptions: true,
    permissionOptionKinds: 'any',
    permissionRules: 'protocol',
    usage: { context: true, turnTokens: false, cost: false },
    prompt: { image: !!prompt.image, audio: !!prompt.audio, embeddedContext: !!prompt.embeddedContext },
    mcp: { stdio: true, http: !!mcp.http, sse: !!mcp.sse },
    slashCommands: true,
    interactiveSlashCommands: false,
    login: loginKind(init),
    clientFs: true,
    quirks: [],
  };
}

function loginKind(init: InitializeResponse): AcpDriverCapabilities['login'] {
  const methods = init.authMethods ?? [];
  if (methods.length === 0) return 'none';
  if (methods.some((m) => m.type === 'terminal' || (m._meta && 'terminal-auth' in m._meta))) return 'terminal';
  return 'agent';
}

/**
 * The command a terminal login method asks the client to run, if any.
 * `type: "terminal"` methods re-run the agent binary with `args`; the older
 * `_meta["terminal-auth"]` convention (Copilot) names a command outright.
 */
export function terminalLoginCommand(
  init: InitializeResponse,
  agentBinary: string,
): { command: string; args: string[]; env?: Record<string, string>; label?: string } | null {
  for (const m of init.authMethods ?? []) {
    if (m.type === 'terminal') {
      return { command: agentBinary, args: m.args ?? [], ...(m.env && { env: m.env }), label: m.name };
    }
    const legacy = m._meta?.['terminal-auth'];
    if (legacy && typeof legacy === 'object') {
      const l = legacy as { command?: unknown; args?: unknown; label?: unknown };
      if (typeof l.command === 'string') {
        return {
          command: l.command,
          args: Array.isArray(l.args) ? l.args.filter((a): a is string => typeof a === 'string') : [],
          ...(typeof l.label === 'string' && { label: l.label }),
        };
      }
    }
  }
  return null;
}
