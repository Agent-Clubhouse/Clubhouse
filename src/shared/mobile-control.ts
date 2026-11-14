/** Additive mobile control contract. Annex's existing protocol remains v2. */
import type { ChatCapabilities, ChatModelOption, ChatQuestionAnswers, PermissionLevel } from './chat';
import type { AgentIdleSleep } from './idle-sleep';
import type { ContextWindowApplies, ContextWindowChoice, ContextWindowKind } from './context-window';
import type { OrchestrationPolicy, OrchestrationPolicyPatch } from './orchestration-policy';
import type { AccessLevel } from './agent-access';
export const MOBILE_PROTOCOL_VERSION = 1;
export const MOBILE_COMMAND_TYPES = ['chat.send', 'chat.interrupt', 'chat.permission', 'chat.question', 'chat.queue.remove', 'agent.start', 'agent.stop', 'agent.spawn', 'agent.create', 'agent.update', 'project.setPinned', 'project.setInactive', 'helper.approve', 'helper.decline', 'chat.setModel', 'chat.setLevel', 'quick.dismiss', 'quick.clear', 'dispatcher.setEnabled', 'helperRouting.update', 'agent.providerPreview', 'agent.providerChange', 'grant.answer', 'dispatcher.update', 'dispatcher.setModels', 'dispatcher.clearChat', 'dispatcher.forgetEverything', 'app.update.request', 'app.update.cancel'] as const;
interface CommandBase { version: 1; commandId: string; epoch: string }
interface ChatTarget { agentId: string; sessionId: string }
export type MobileCommand = CommandBase & (
  // `text` may be empty when `attachmentIds` (from POST /mobile/agents/:id/attachments) carries images.
  | (ChatTarget & { type: 'chat.send'; text: string; delivery?: 'auto' | 'prompt' | 'steer' | 'queued'; attachmentIds?: string[] })
  | (ChatTarget & { type: 'chat.interrupt' })
  | (ChatTarget & { type: 'chat.queue.remove'; messageIds: string[] })
  | (ChatTarget & { type: 'chat.permission'; requestId: string; optionId: string; /** The digest from the full-event route, for a request a phone was sent only a preview of (#2731). */ reviewedDigest?: string })
  | (ChatTarget & { type: 'chat.question'; requestId: string; answers: ChatQuestionAnswers })
  // `effort` omitted keeps a chosen effort the new model offers; null is the provider's default (capabilities.effortDefault).
  | (ChatTarget & { type: 'chat.setModel'; model: string; effort?: string | null })
  | (ChatTarget & { type: 'chat.setLevel'; level: PermissionLevel })
  | { type: 'agent.start'; agentId: string; message?: string; resume?: boolean; expectedProvider?: string; expectedSessionId?: string }
  | { type: 'agent.stop'; agentId: string; waitForStopped?: boolean }
  | { type: 'agent.providerPreview'; agentId: string; provider: string }
  | { type: 'agent.providerChange'; agentId: string; provider: string; expectedState: string }
  | { type: 'agent.spawn'; projectId: string; prompt: string; model?: string; orchestrator?: string }
  | ({ type: 'agent.create' } & MobileAgentCreate)
  | ({ type: 'agent.update' } & MobileAgentUpdate)
  | { type: 'project.setPinned'; projectId: string; pinned: boolean }
  | { type: 'project.setInactive'; projectId: string; inactive: boolean }
  // A helper start or dispose waiting on the user (#159). `force` approves a dispose that would lose work ("Dispose anyway").
  | { type: 'helper.approve'; requestId: string; force?: boolean }
  | { type: 'helper.decline'; requestId: string }
  // A Clubhouse permission request waiting on the user (#3205): an Ask-first call or a request_grant ask.
  | { type: 'grant.answer'; requestId: string; answer: MobileGrantAnswer; updateMode?: import('./app-update').AppUpdateMode }
  | { type: 'app.update.request' }
  | { type: 'app.update.cancel'; requestId: string }
  // The start page's "Finished, waiting on you" list (#2467).
  | { type: 'quick.dismiss'; projectId: string; agentId: string }
  | { type: 'quick.clear'; projectId: string }
  // Settings > Dispatcher's switch (#2533).
  | { type: 'dispatcher.setEnabled'; enabled: boolean }
  // Settings > Dispatcher from a phone (#3206): Behavior, name and look, personality; at least one.
  | ({ type: 'dispatcher.update' } & MobileDispatcherUpdate)
  // Choose models yourself (#3191): the switch, or one job's fields.
  | { type: 'dispatcher.setModels'; byHand?: boolean; role?: string; provider?: string; model?: string; effort?: string | null; contextWindow?: string | null }
  // Confirmed with the `expectedState` the Dispatcher settings route gave for each (#3206).
  | { type: 'dispatcher.clearChat'; expectedState: string }
  | { type: 'dispatcher.forgetEverything'; expectedState: string }
  // App-wide helper presets (#2671). `revision` is what the change was made from; 409 helper_routing_stale changes nothing.
  | ({ type: 'helperRouting.update'; scope: string; projectId?: string } & import('./helper-routing').HelperRoutingUpdate)
);
/** A durable agent, as the New agent page makes one. */
export interface MobileAgentCreate {
  projectId: string; name: string; color: string; orchestrator?: string; model?: string; persona?: string;
  freeAgentMode?: boolean; useWorktree?: boolean; mcpIds?: string[]; branchName?: string; branchFrom?: string; folderName?: string;
  /** Access (#3207): the level it starts at. Wins over `freeAgentMode`; neither gives the desktop's Default access. */
  access?: AccessLevel;
  /** The agent's orchestration policy fields to set (#2228); unset ones follow the defaults. `persona` is refused (409 managed_agent): personas were retired (#2901). */
  orchestration?: Partial<OrchestrationPolicy>;
}
/** Settings a phone may change; null clears. */
export interface MobileAgentUpdate {
  agentId: string; name?: string; color?: string; emoji?: string | null; orchestrator?: string; model?: string;
  runtime?: 'default' | 'chat' | 'terminal'; persona?: string | null; clubhouseMode?: boolean; freeAgentMode?: boolean; idleSleep?: AgentIdleSleep;
  /** Access (#3207): the saved level it starts at. Wins over `freeAgentMode` in the same command. */
  access?: AccessLevel;
  /** A `settings.contextWindow.choices[].id`, or null to clear it. */
  contextWindow?: string | null;
  /** Orchestration policy fields; a field set to null, or the whole object null, goes back to the default. A `persona` value is refused (409 managed_agent) and `null` is a no-op: personas were retired (#2901). */
  orchestration?: OrchestrationPolicyPatch | null;
}
/** dispatcher.update (#3206): what Settings > Dispatcher's Identity and Behavior sections change. */
export interface MobileDispatcherUpdate {
  behavior?: string;
  name?: string;
  color?: string;
  emoji?: string | null;
  /** A preset fills the text; text alone becomes Custom unless it is a preset's own. */
  personality?: { preset?: string; text?: string };
}

/**
 * Why the Dispatcher's settings route lists one of its raw agent settings as
 * not honored (#3206). `behavior`: Behavior gives it before each start, so a
 * saved change doesn't last. `not_offered`: Settings > Dispatcher no longer
 * offers it, and it stays as it is.
 */
export type MobileDispatcherNotHonoredReason = 'behavior' | 'not_offered';
export interface MobileDispatcherNotHonored { setting: 'model' | 'contextWindow' | 'runtime' | 'freeAgentMode' | 'access'; reason: MobileDispatcherNotHonoredReason }

/**
 * The Dispatcher's raw agent settings (`GET /mobile/agents/:id/settings`)
 * that Settings > Dispatcher no longer offers, so a phone hides them (#3206).
 * With Choose models yourself on (#3191), CLI, model and context are the pick
 * for talking with you and are honored; off, Behavior gives the model, and a
 * new model clears the context.
 */
export function dispatcherNotHonored(modelsByHand: boolean): MobileDispatcherNotHonored[] {
  return [
    ...(modelsByHand ? [] : [{ setting: 'model', reason: 'behavior' }, { setting: 'contextWindow', reason: 'behavior' }] as const),
    { setting: 'runtime', reason: 'not_offered' },
    { setting: 'freeAgentMode', reason: 'not_offered' },
    { setting: 'access', reason: 'not_offered' },
  ];
}

/** What the desktop windows patch into their agent list after a phone's agent.update. */
export interface AnnexAgentUpdate {
  agentId: string; name: string; color: string; emoji: string | null; model: string | null; orchestrator: string | null;
  freeAgentMode: boolean;
  /** The saved Access level (#3207). */
  access: AccessLevel;
}
/**
 * The chat snapshot's `chatControls`: what the composer's level, model and
 * effort pills show, for chat.setLevel and chat.setModel. `efforts` are the
 * current model's. `switchNote` is the pills' "Applies from the next message."
 */
export interface MobileChatControls {
  model: string | null;
  /** First model named in the current session. Absent on older desktops; compare with model, not a saved alias. */
  startModel?: string | null;
  /** The session runs the provider's default model and hasn't named it yet ("Default model"). */
  modelUnknown: boolean;
  effort: string | null;
  effortIsDefault: boolean;
  /** False until the session reports its effort; hide the effort chip until then. */
  effortReported: boolean;
  level: PermissionLevel | null;
  models: ChatModelOption[];
  efforts: string[];
  levelNames: Partial<Record<PermissionLevel, string>>;
  liveLevels: PermissionLevel[];
  modelSwitch: ChatCapabilities['modelSwitch'];
  effortSwitch: ChatCapabilities['effortSwitch'];
  effortDefault: boolean;
  switchNote: string | null;
  /**
   * The running session's context as the CLI reports it (#2660): what it runs
   * with now, where `settings.contextWindow.value` is the next start's choice.
   * Null until it reports; a null field isn't reported, so show no estimate.
   */
  context: { effectiveTokens: number | null; compactAtTokens: number | null; reservedTokens: number | null; note: string | null } | null;
}
/** When a setting can change: at any time, only while the agent sleeps, or not from a phone. */
export type MobileSettingEditable = 'always' | 'sleeping' | 'never';
/** One Access level as the desktop's picker names it (#3207). */
export interface MobileAccessLevel { id: AccessLevel; label: string; description: string }
/**
 * `settings.access` (#3207): the saved level the agent starts at, on the
 * five-level ladder. `choices` are the levels its CLI and runtime can start
 * at, `startsAt` the level it really starts at (the nearest lower one its
 * runtime has, when the saved one isn't), `default` the desktop's Default
 * access for new agents. A change always applies at the next start: a running
 * session's level is `chatControls.level`, which chat.setLevel changes.
 */
export interface MobileAccess {
  value: AccessLevel;
  editable: MobileSettingEditable;
  choices: MobileAccessLevel[];
  startsAt: AccessLevel;
  default: AccessLevel;
  applies: 'next_start';
}
/**
 * `settings.contextWindow` (#2660): the saved next-start choice and what the CLI
 * offers for this model. `configurable` is whether the CLI offers it, `editable`
 * when Clubhouse lets it change. `value` is a `choices[].id`, or null for none.
 */
export interface MobileContextWindow {
  value: string | null;
  editable: MobileSettingEditable;
  configurable: boolean;
  kind: ContextWindowKind | null;
  label: string;
  description: string | null;
  defaultLabel: string | null;
  choices: ContextWindowChoice[];
  defaultTokens: number | null;
  maxTokens: number | null;
  costNote: string | null;
  applies: ContextWindowApplies[];
  state: 'unsupported' | 'pick_model' | 'unavailable' | null;
  reason: string | null;
  /** Why a saved choice was last cleared; gone after the next explicit choice. */
  notice: string | null;
}
export interface MobileReceipt {
  version: 1;
  commandId?: string;
  epoch: string;
  status: 'completed' | 'rejected' | 'failed';
  result?: unknown;
  error?: { code: string; message: string };
}
export interface MobileResponse { statusCode: number; body: MobileReceipt }

/**
 * A helper start or dispose an orchestrator asked the user to decide (#159),
 * as the Annex snapshot's `helperRequests` lists it. The desktop's Needs you
 * shows the same requests with `summary` as its line.
 */
export interface MobileHelperRequest {
  requestId: string;
  kind: 'start' | 'dispose';
  projectId: string;
  /** The orchestrator that asked. */
  requester: { agentId: string; name: string };
  /** The helper to start or dispose. A start's helper has no id until it is approved. */
  helper: { agentId: string | null; name: string };
  /** ISO times. A start expires; a dispose waits until it is answered. */
  requestedAt: string;
  expiresAt: string | null;
  /** The desktop's Needs you line. */
  summary: string;
  /** For a start: what the helper is asked to do and how. */
  /** For a start that named a CLI, model, effort or difficulty (#2671). What it resolves to is decided at approval. */
  requestedRouting?: { provider: string | null; model: string | null; effort: string | null; difficulty: string | null };
  /** A provider this start names looked unwell when it was asked, as of `asOf`. Show `message`. It never blocks an approval. */
  startWarning?: import('./helper-routing').HelperStartWarning;
  start?: { task: string; persona: string | null; model: string | null; access: string | null; branchFrom: string | null };
  /**
   * For a dispose: what disposing would lose. `canDispose` is false when a
   * check couldn't run (only Decline then); `workAtRisk` means approving
   * needs `force: true`, the desktop's "Dispose anyway".
   */
  dispose?: { uncommittedFiles: number; unpushedCommits: number; unmergedCommits: number | null; checkError: string | null;
    forceRequested: boolean; workAtRisk: boolean; canDispose: boolean };
}

/**
 * How a device that controls this computer (a paired phone, or a desktop or
 * phone in its Annex Network) answers a Clubhouse permission request (#3205), as Needs you
 * does. `allow_once` lets one call through, with exactly the arguments shown,
 * and changes no permission; it is only for a `call` request. `allow_lasting`
 * adds the permission to the agent's saved permissions; it is only for a
 * `grant` request. Each request lists the answers it takes.
 */
export const MOBILE_GRANT_ANSWERS = ['allow_once', 'allow_lasting', 'decline'] as const;
export type MobileGrantAnswer = typeof MOBILE_GRANT_ANSWERS[number];

/**
 * A Clubhouse permission request waiting on the user (#3205), as the Annex
 * snapshot's `grantRequests` lists it: an agent's call that a permission set
 * to Ask first held (#2970, Manage devices included, #3068), or an agent's
 * `request_grant` ask (#3021). Not a CLI `permission_request`, and not a
 * helper start or dispose (`helperRequests`). Each device's snapshot leaves
 * out a Manage devices call that names that device.
 */
export interface MobileGrantRequest {
  requestId: string;
  /** Present only for app.update. Allow once requires an explicit updateMode. */
  update?: import('./app-update').AppUpdateApproval;
  kind: 'call' | 'grant';
  /** The asking agent's project; `__dispatcher__` for the Dispatcher. */
  projectId: string;
  agent: { agentId: string; name: string };
  /** The permissions it needs (a call can need more than one), and their labels. */
  actions: string[];
  actionLabels: string[];
  /** Where, in the user's terms ("your helpers", "the app"). */
  where: string;
  /** `call`: the tool it called. */
  toolName: string | null;
  /** `grant`: the target the permission would be on. */
  target: import('./agent-grants').GrantTarget | null;
  /** The desktop's Needs you line. */
  summary: string;
  /** `call`: the host's plain-words line for the call, such as which device it removes. */
  detail: string | null;
  /** `call`: the call's arguments in full, as JSON. Allow once covers exactly these. */
  arguments: string | null;
  /** The agent's reason, in its words. */
  reason: string | null;
  /** What allowing does, as the desktop says it under the request. */
  allowEffect: string;
  /** ISO times. A request expires at `expiresAt` (24 hours). */
  requestedAt: string;
  expiresAt: string;
  /** The answers this request takes: `allow_once` and `decline` for a call, `allow_lasting` and `decline` for a grant. */
  answers: MobileGrantAnswer[];
}
