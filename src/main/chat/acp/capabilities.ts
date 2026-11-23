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

import { MINIMAL_CHAT_CAPABILITIES, type ChatCapabilities } from '../../../shared/chat/capabilities';
import type { AuthMethod, Implementation, InitializeResponse, SessionConfigOption } from './protocol';

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
}

/** Observed in this session's setup responses and updates. */
export interface AcpSessionFacts {
  configOptions: readonly SessionConfigOption[];
  /** An `available_commands_update` arrived with at least one command. */
  commands: boolean;
  /** A `usage_update` arrived. */
  usage: boolean;
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

export function acpChatCapabilities(n: AcpNegotiated, facts: AcpSessionFacts, claims: AcpStaticClaims = {}): ChatCapabilities {
  return {
    ...MINIMAL_CHAT_CAPABILITIES,
    // Stable v1 has one session/prompt per turn and no steer method.
    steer: false,
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
    // Permission levels map onto provider-specific modes; that's provider policy.
    liveLevels: [],
    // Clubhouse never calls `authenticate`; a login happens in the CLI itself.
    login: n.authMethods.length ? 'terminal' : 'none',
    systemPrompt: n.systemPrompt,
  };
}
