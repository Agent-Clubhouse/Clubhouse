/**
 * ChatCapabilities for an ACP session, from three sources kept apart:
 *
 * 1. Negotiated: what `initialize` advertised (AcpNegotiated).
 * 2. Observed: what this session reported (config options, commands, usage).
 * 3. Static claims: facts the provider documents that ACP v1 has no way to
 *    advertise (AcpStaticClaims, from the launch spec). A claim can only fill
 *    such a gap. It never turns on something the handshake left off.
 *
 * Each field's derivation is written next to it below. Where ACP makes a
 * feature mandatory for every agent, its absence from `initialize` doesn't
 * mean the agent lacks it (session/cancel, for one, has no advertise bit).
 */

import { MINIMAL_CHAT_CAPABILITIES, type ChatCapabilities, type PermissionLevel } from '../../../shared/chat/capabilities';
import type { AuthMethod, Implementation, InitializeResponse, SessionConfigOption, SessionModeState } from './protocol';

export interface AcpNegotiated {
  protocolVersion: number;
  agentInfo?: Implementation;
  loadSession: boolean;
  resume: boolean;
  close: boolean;
  systemPrompt: boolean;
  prompt: { image: boolean; audio: boolean; embeddedContext: boolean };
  mcp: { http: boolean; sse: boolean };
  authMethods: AuthMethod[];
  /** Clubhouse advertised form elicitation in its own clientCapabilities. */
  clientElicitationForm: boolean;
}

/**
 * Provider facts ACP v1 can't negotiate. Each must come from the provider's
 * public docs; absent means "not claimed", which reads as unsupported.
 */
export interface AcpStaticClaims {
  /**
   * The agent asks structured questions with `elicitation/create`. ACP has no
   * agent-side bit for this. Only honoured when Clubhouse advertised form
   * elicitation, since otherwise the agent may not send any.
   */
  questions?: boolean;
  /** The agent sends `usage_update` (context fill). ACP has no bit for it. */
  usageContext?: boolean;
  /**
   * A `session/prompt` written while a turn runs joins that turn instead of
   * starting a new one (Antigravity documents this). ACP v1 has no steer
   * method or bit, and the docs don't say how each prompt is answered, so the
   * driver keeps one turn open until every prompt in it has been answered.
   */
  steer?: boolean;
}

/**
 * Provider policy mapping Clubhouse's permission levels onto the agent's
 * session modes. ACP has modes but no shared meaning for their ids, so this
 * is the provider's mapping from its docs. A level only counts as available
 * when the session itself offers the mapped mode.
 */
export interface AcpLevelPolicy {
  /** The mode id for a level, or undefined when the level isn't a session mode. */
  mode(level: PermissionLevel): string | undefined;
  /**
   * Levels set only by how the process is launched (a CLI flag in
   * `AcpLaunchSpec.args`), so changing to or from one needs a restart.
   */
  processLevels?: readonly PermissionLevel[];
}

/** The session's mode choice, from a `mode` config option or the `modes` state, whichever the agent sent. */
export interface AcpModeChoice {
  current: string;
  available: string[];
  /** How a change is sent: `session/set_config_option` with this option id, or `session/set_mode`. */
  via: { configId: string } | 'set_mode';
}

export function modeChoice(configOptions: readonly SessionConfigOption[], modes: SessionModeState | undefined): AcpModeChoice | undefined {
  const option = selectOption(configOptions, 'mode');
  if (option) {
    const available = option.options.flatMap((o) => ('group' in o ? o.options : [o])).map((o) => o.value);
    return { current: option.currentValue, available, via: { configId: option.id } };
  }
  if (modes && typeof modes.currentModeId === 'string' && Array.isArray(modes.availableModes)) {
    return { current: modes.currentModeId, available: modes.availableModes.map((m) => m.id), via: 'set_mode' };
  }
  return undefined;
}

/** Levels the session can switch to live: mapped, offered by the session, and not set by the launch. */
export function liveLevelsFor(policy: AcpLevelPolicy | undefined, choice: AcpModeChoice | undefined, launchedLevel: PermissionLevel | undefined): PermissionLevel[] {
  if (!policy || !choice) return [];
  // A process-level launch (e.g. skip all permission prompts) can't be left without a restart.
  if (launchedLevel && policy.processLevels?.includes(launchedLevel)) return [];
  return PERMISSION_LEVEL_ORDER.filter((level) => {
    const mode = policy.mode(level);
    return mode !== undefined && !policy.processLevels?.includes(level) && choice.available.includes(mode);
  });
}

/** The level a mode id maps back to, when exactly one level maps to it. */
export function levelForMode(policy: AcpLevelPolicy | undefined, modeId: string): PermissionLevel | undefined {
  if (!policy) return undefined;
  const matches = PERMISSION_LEVEL_ORDER.filter((level) => policy.mode(level) === modeId);
  return matches.length === 1 ? matches[0] : undefined;
}

const PERMISSION_LEVEL_ORDER: readonly PermissionLevel[] = ['plan', 'ask', 'auto_edit', 'auto', 'full_access'];

/** Observed in this session's setup responses and updates. */
export interface AcpSessionFacts {
  configOptions: readonly SessionConfigOption[];
  /** An `available_commands_update` arrived with at least one command. */
  commands: boolean;
  /** A `usage_update` arrived. */
  usage: boolean;
  /** The `modes` state from the setup answer, kept current by `current_mode_update`. */
  modes?: SessionModeState;
}

export function negotiate(init: InitializeResponse, clientElicitationForm: boolean): AcpNegotiated {
  const caps = init.agentCapabilities ?? {};
  const session = caps.sessionCapabilities ?? {};
  const prompt = caps.promptCapabilities ?? {};
  // The schema says omitted and null both mean "not advertised"; {} means supported.
  const has = (v: unknown) => v !== undefined && v !== null;
  return {
    protocolVersion: init.protocolVersion,
    ...(init.agentInfo && { agentInfo: init.agentInfo }),
    loadSession: caps.loadSession === true,
    resume: has(session.resume),
    close: has(session.close),
    systemPrompt: has(session.systemPrompt),
    prompt: { image: prompt.image === true, audio: prompt.audio === true, embeddedContext: prompt.embeddedContext === true },
    mcp: { http: caps.mcpCapabilities?.http === true, sse: caps.mcpCapabilities?.sse === true },
    authMethods: Array.isArray(init.authMethods) ? init.authMethods : [],
    clientElicitationForm,
  };
}

/** The config option for a category, when it's a select (the only kind a picker can drive). */
export function selectOption(options: readonly SessionConfigOption[], category: string): Extract<SessionConfigOption, { type: 'select' }> | undefined {
  return options.find((o): o is Extract<SessionConfigOption, { type: 'select' }> => o.category === category && o.type === 'select');
}

export function acpChatCapabilities(
  n: AcpNegotiated,
  facts: AcpSessionFacts,
  claims: AcpStaticClaims = {},
  levels?: { policy?: AcpLevelPolicy; launched?: PermissionLevel },
): ChatCapabilities {
  return {
    ...MINIMAL_CHAT_CAPABILITIES,
    // The stable schema has no steer method. Only a provider that documents
    // that a prompt sent mid-turn joins the turn claims it.
    steer: claims.steer === true,
    // No protocol queue; the chat runtime holds messages until the turn ends.
    queue: 'client',
    // session/cancel is baseline for every agent (SessionCapabilities), and the
    // agent MUST answer the prompt with stopReason `cancelled`.
    interrupt: true,
    // resume reopens without replay; load replays history as updates.
    resume: n.resume ? 'native' : n.loadSession ? 'replay' : 'none',
    // No structured plan approval in v1; plans arrive as `plan` updates only.
    planApproval: false,
    questions: n.clientElicitationForm && claims.questions === true,
    // subagent_update exists in the stable schema, but the client must
    // advertise `subagents` for it, and Clubhouse doesn't yet.
    subagents: 'none',
    usage: facts.usage || claims.usageContext === true ? 'context' : 'none',
    limits: false,
    images: n.prompt.image,
    slashCommands: facts.commands,
    modelSwitch: selectOption(facts.configOptions, 'model') ? 'live' : 'none',
    effortSwitch: selectOption(facts.configOptions, 'thought_level') ? 'live' : 'none',
    // Permission levels map onto provider-specific modes (the launch spec's
    // policy); only modes this session offers count.
    liveLevels: liveLevelsFor(levels?.policy, modeChoice(facts.configOptions, facts.modes), levels?.launched),
    // Not negotiated: Clubhouse doesn't advertise terminal auth or call
    // `authenticate`, and an empty authMethods list doesn't prove no login is
    // needed. The baseline (log in with the CLI itself) stands.
    login: MINIMAL_CHAT_CAPABILITIES.login,
    systemPrompt: n.systemPrompt,
  };
}
