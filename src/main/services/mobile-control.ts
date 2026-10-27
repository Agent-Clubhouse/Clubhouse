import { createHash, randomUUID } from 'crypto';
import type { AgentRuntime, ChatCapabilities, ChatEvent, ContentBlock, PermissionLevel } from '../../shared/chat';
import { CHAT_ATTACHMENTS_MAX, PERMISSION_LEVELS, switchNote } from '../../shared/chat';
import { MOBILE_COMMAND_TYPES, type MobileChatControls, type MobileCommand, type MobileResponse } from '../../shared/mobile-control';
import { AGENT_IDLE_SLEEP_MINUTES } from '../../shared/idle-sleep';

export class MobileControlError extends Error {
  /** `detail` is a sentence for the user (e.g. why a name was refused); the receipt's message falls back to the code. */
  constructor(readonly code: string, readonly statusCode = 409, readonly outcome: 'rejected' | 'failed' = 'rejected', readonly detail?: string) { super(code); }
}

const FIELDS: Record<MobileCommand['type'], string[]> = {
  'chat.send': ['agentId', 'sessionId', 'text', 'delivery', 'attachmentIds'],
  'chat.interrupt': ['agentId', 'sessionId'],
  'chat.queue.remove': ['agentId', 'sessionId', 'messageIds'],
  'chat.permission': ['agentId', 'sessionId', 'requestId', 'optionId'],
  'chat.question': ['agentId', 'sessionId', 'requestId', 'answers'],
  'chat.setModel': ['agentId', 'sessionId', 'model', 'effort'],
  'chat.setLevel': ['agentId', 'sessionId', 'level'],
  'agent.start': ['agentId', 'message', 'resume'],
  'agent.stop': ['agentId'],
  'agent.spawn': ['projectId', 'prompt', 'model', 'orchestrator'],
  'agent.create': ['projectId', 'name', 'color', 'orchestrator', 'model', 'persona', 'useWorktree', 'mcpIds', 'branchName', 'branchFrom', 'folderName'],
  'agent.update': ['agentId', 'name', 'color', 'emoji', 'orchestrator', 'model', 'runtime', 'persona', 'clubhouseMode', 'idleSleep'],
  'project.setPinned': ['projectId', 'pinned'],
  'project.setInactive': ['projectId', 'inactive'],
  'helper.approve': ['requestId', 'force'],
  'helper.decline': ['requestId'],
};
/** Fields a command may leave out. Every agent.update setting is optional, but it needs at least one. */
const OPTIONAL = new Set(['delivery', 'message', 'resume', 'model', 'orchestrator', 'attachmentIds', 'force', 'effort']);
const CREATE_OPTIONAL = new Set(['orchestrator', 'model', 'persona', 'useWorktree', 'mcpIds', 'branchName', 'branchFrom', 'folderName']);
const isOptional = (type: MobileCommand['type'], key: string): boolean =>
  type === 'agent.update' ? key !== 'agentId' : type === 'agent.create' ? CREATE_OPTIONAL.has(key)
    : type === 'chat.setModel' && key === 'model' ? false : OPTIONAL.has(key);
const BOOLEAN_FIELDS = new Set(['resume', 'useWorktree', 'clubhouseMode', 'pinned', 'inactive', 'force']);
/** Fields agent.update clears with null. */
const NULLABLE_ON_UPDATE = new Set(['emoji', 'persona']);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const idleSleep = (v: unknown): boolean => v === 'inherit' || v === 'never' || (AGENT_IDLE_SLEEP_MINUTES as readonly unknown[]).includes(v);
export function parseMobileCommand(value: unknown): MobileCommand {
  if (!record(value)) throw new MobileControlError('invalid_command', 400);
  if (value.version !== 1) throw new MobileControlError('unsupported_version', 400);
  if (!text(value.commandId, 128) || !text(value.epoch, 128) || !MOBILE_COMMAND_TYPES.includes(value.type as MobileCommand['type'])) throw new MobileControlError('invalid_command', 400);
  const type = value.type as MobileCommand['type'];
  // Remote commands cannot elevate permissions: say so, rather than a bare unknown field.
  if ((type === 'agent.create' || type === 'agent.update') && 'freeAgentMode' in value) throw new MobileControlError('free_agent_mode_not_allowed', 403);
  const fields = FIELDS[type];
  if (Object.keys(value).some((k) => !['version', 'commandId', 'epoch', 'type', ...fields].includes(k))) throw new MobileControlError('invalid_command', 400);
  for (const key of fields) {
    const v = value[key];
    if (isOptional(type, key) && v === undefined) continue;
    if (type === 'agent.update' && NULLABLE_ON_UPDATE.has(key) && v === null) continue;
    if (BOOLEAN_FIELDS.has(key)) { if (typeof v !== 'boolean') throw new MobileControlError('invalid_command', 400); }
    else if (key === 'attachmentIds') {
      if (!Array.isArray(v) || v.length === 0 || v.length > CHAT_ATTACHMENTS_MAX || v.some((id) => !text(id, 128)) || new Set(v).size !== v.length) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'text' && value.type === 'chat.send' && v === '' && value.attachmentIds !== undefined) continue; // image-only message
    else if (key === 'messageIds') {
      if (!Array.isArray(v) || v.length === 0 || v.length > 1000 || v.some((id) => !text(id, 128))) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'mcpIds') {
      if (!Array.isArray(v) || v.length > 100 || v.some((id) => !text(id, 128)) || new Set(v).size !== v.length) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'answers') {
      if (!record(v) || Object.keys(v).length > 100 || Object.entries(v).some(([k, a]) => !text(k) || !(text(a, 65536) || (Array.isArray(a) && a.length <= 100 && a.every((x) => text(x, 65536)))))) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'idleSleep') { if (!idleSleep(v)) throw new MobileControlError('invalid_command', 400); }
    else if (key === 'effort') { if (v !== null && !text(v, 64)) throw new MobileControlError('invalid_command', 400); }
    else if (key === 'level') { if (!(PERMISSION_LEVELS as readonly unknown[]).includes(v)) throw new MobileControlError('invalid_command', 400); }
    else if (key === 'runtime') { if (!['default', 'chat', 'terminal'].includes(v as string)) throw new MobileControlError('invalid_command', 400); }
    else if (!text(v, ['text', 'message', 'prompt'].includes(key) ? 65536 : key === 'emoji' ? 16 : 256)) throw new MobileControlError('invalid_command', 400);
  }
  if (value.delivery !== undefined && !['auto', 'prompt', 'steer', 'queued'].includes(value.delivery as string)) throw new MobileControlError('invalid_command', 400);
  if (type === 'agent.update' && !fields.some((k) => k !== 'agentId' && value[k] !== undefined)) throw new MobileControlError('invalid_command', 400);
  return value as unknown as MobileCommand;
}

/** Stable JSON fingerprint; object key order must not change retry semantics. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
interface Entry { fingerprint: string; expires: number; response: Promise<MobileResponse>; settled: boolean }
export const MOBILE_COMMAND_TTL_MS = 60 * 60 * 1000;
export const MOBILE_COMMAND_MAX_ENTRIES = 2048;
/** In-memory retry receipts. No credentials or trust settings are changed. */
export class MobileCommandService {
  epoch = randomUUID();
  private entries = new Map<string, Entry>();
  constructor(private readonly now = Date.now, private readonly capacity = MOBILE_COMMAND_MAX_ENTRIES) {}
  reset(): void { this.epoch = randomUUID(); this.entries.clear(); }
  reject(code: string, statusCode: number, commandId?: string): MobileResponse {
    return { statusCode, body: { version: 1, epoch: this.epoch, commandId, status: 'rejected', error: { code, message: code } } };
  }
  async execute(principal: string | undefined, input: unknown, run: (command: MobileCommand) => Promise<unknown>): Promise<MobileResponse> {
    // Enforced again here even if a new transport forgets its gate.
    if (!principal) return this.reject('client_certificate_required', 403);
    let command: MobileCommand;
    try { command = parseMobileCommand(input); }
    catch (e) { // telemetry-exempt: bounded validation errors are returned to the caller, with no content logged.
      const err = e as MobileControlError; return this.reject(err.code, err.statusCode); }
    if (command.epoch !== this.epoch) return this.reject('epoch_mismatch', 409, command.commandId);
    for (const [key, entry] of this.entries) if (entry.settled && entry.expires <= this.now()) this.entries.delete(key);
    const key = JSON.stringify([principal, command.commandId]);
    const fingerprint = createHash('sha256').update(canonical(command)).digest('hex');
    const existing = this.entries.get(key);
    if (existing) return existing.fingerprint === fingerprint ? existing.response : this.reject('command_conflict', 409, command.commandId);
    if (this.entries.size >= this.capacity) return this.reject('command_capacity', 429, command.commandId);
    const epoch = this.epoch;
    // Reserve synchronously before executing, including while the first request is in flight.
    const entry: Entry = { fingerprint, expires: Infinity, settled: false, response: Promise.resolve().then(async () => {
      try {
        const result = await run(command);
        return { statusCode: 200, body: { version: 1 as const, commandId: command.commandId, epoch, status: 'completed' as const, result } };
      } catch (err) {
        // telemetry-exempt: the receipt reports failure; runtime operations own detailed error telemetry.
        const known = err instanceof MobileControlError;
        const code = known ? err.code : 'command_failed';
        const message = known && err.detail ? err.detail : code;
        return { statusCode: known ? err.statusCode : 500, body: { version: 1 as const, commandId: command.commandId, epoch, status: known ? err.outcome : 'failed' as const, error: { code, message } } };
      } finally { entry.settled = true; entry.expires = this.now() + MOBILE_COMMAND_TTL_MS; }
    }) };
    this.entries.set(key, entry);
    return entry.response;
  }
}

export function pendingInteractions(events: ChatEvent[]) {
  const permissions = new Map<string, Extract<ChatEvent, { type: 'permission_request' }>>();
  const questions = new Map<string, Extract<ChatEvent, { type: 'question' }>>();
  for (const event of events) {
    if (event.type === 'permission_request') permissions.set(event.data.requestId, event);
    if (event.type === 'permission_resolved') permissions.delete(event.data.requestId);
    if (event.type === 'question') questions.set(event.data.requestId, event);
    if (event.type === 'question_resolved') questions.delete(event.data.requestId);
    if (event.type === 'session_ended') { permissions.clear(); questions.clear(); }
  }
  return { pendingPermissions: [...permissions.values()], pendingQuestions: [...questions.values()] };
}

/**
 * The composer's level, model and effort state for a session (#2462), folded
 * from its events the way the desktop chat store folds them.
 */
export function chatControls(events: ChatEvent[], caps: ChatCapabilities | undefined): MobileChatControls {
  let model: string | null = null; let modelUnknown = false;
  let effort: string | null = null; let effortIsDefault = false; let effortReported = false;
  let level: PermissionLevel | null = null;
  let models: MobileChatControls['models'] = []; let efforts: string[] = []; let levelNames: MobileChatControls['levelNames'] = {};
  for (const event of events) {
    if (event.type === 'session_started') {
      model = event.data.model ?? model; modelUnknown = false; level = event.data.level ?? level;
      models = []; efforts = []; levelNames = {};
    } else if (event.type === 'session_info') {
      const d = event.data;
      if (d.model !== undefined) { model = d.model; modelUnknown = d.model === null; }
      models = d.models ?? models; efforts = d.efforts ?? efforts; levelNames = d.levelNames ?? levelNames;
    } else if (event.type === 'model_changed') {
      model = event.data.modelId; modelUnknown = false;
      effort = event.data.effort ?? null; effortIsDefault = event.data.effortIsDefault === true; effortReported = true;
    } else if (event.type === 'mode_changed') level = event.data.level;
  }
  const modelSwitch = caps?.modelSwitch ?? 'none';
  const effortSwitch = caps?.effortSwitch ?? 'none';
  return {
    model, modelUnknown, effort, effortIsDefault, effortReported, level, models, efforts, levelNames,
    liveLevels: [...(caps?.liveLevels ?? [])], modelSwitch, effortSwitch, effortDefault: caps?.effortDefault === true,
    switchNote: switchNote(modelSwitch, effortSwitch) ?? null,
  };
}

/** Content blocks for a peer's uploaded attachment ids; throws when one isn't usable. */
export type MobileAttachmentResolver = (ids: string[], caps: ChatCapabilities | undefined) => Promise<ContentBlock[]>;

export async function executeChatCommand(command: Extract<MobileCommand, { sessionId: string }>, runtime: AgentRuntime | undefined, canSend: () => Promise<boolean>, assertCurrent: () => void = () => {}, resolveAttachments?: MobileAttachmentResolver): Promise<unknown> {
  assertCurrent();
  if (!runtime || runtime.kind !== 'chat' || !runtime.isRunning()) throw new MobileControlError('not_chat');
  if (runtime.getSessionId?.() !== command.sessionId) throw new MobileControlError('session_mismatch');
  if (command.type === 'chat.send') {
    if (!await canSend()) throw new MobileControlError('revert_in_progress');
    assertCurrent();
    // A session can change while waiting for a revert check.
    if (runtime.getSessionId?.() !== command.sessionId) throw new MobileControlError('session_mismatch');
    const blocks: ContentBlock[] = command.text ? [{ type: 'text', text: command.text }] : [];
    if (command.attachmentIds?.length) {
      const caps = runtime.getCapabilities?.();
      if (caps?.images !== true) throw new MobileControlError('images_not_supported');
      if (!resolveAttachments) throw new MobileControlError('attachment_unavailable');
      try { blocks.push(...await resolveAttachments(command.attachmentIds, caps)); }
      catch { // telemetry-exempt: expired or foreign ids are a bounded caller error; no content is logged.
        throw new MobileControlError('attachment_unavailable'); }
      assertCurrent();
      if (runtime.getSessionId?.() !== command.sessionId) throw new MobileControlError('session_mismatch');
    }
    return runtime.sendMessage(blocks, { source: 'annex', delivery: command.delivery ?? 'auto', clientCommandId: command.commandId });
  }
  if (command.type === 'chat.interrupt') { await runtime.interrupt(); return { interrupted: true }; }
  if (command.type === 'chat.queue.remove') {
    if (!runtime.removeQueued) throw new MobileControlError('queue_removal_not_supported');
    return { removed: await runtime.removeQueued(command.messageIds) };
  }
  const { events = [] } = await runtime.readTranscript();
  assertCurrent();
  if (runtime.getSessionId?.() !== command.sessionId) throw new MobileControlError('session_mismatch');
  if (command.type === 'chat.setModel') return setModel(command, runtime, chatControls(events, runtime.getCapabilities?.()));
  if (command.type === 'chat.setLevel') return setLevel(command, runtime, chatControls(events, runtime.getCapabilities?.()));
  const pending = pendingInteractions(events);
  if (command.type === 'chat.permission') {
    const request = pending.pendingPermissions.find((e) => e.data.requestId === command.requestId);
    const option = request?.data.options.find((o) => o.optionId === command.optionId);
    const activeOption = runtime.getPendingPermissionOptions?.(command.requestId)?.find((o) => o.optionId === command.optionId);
    if (!option || !activeOption || activeOption.kind !== option.kind) throw new MobileControlError('pending_request_not_found');
    if (!['allow_once', 'reject_once', 'cancel_turn'].includes(option.kind)) throw new MobileControlError('persistent_approval_not_supported', 403);
    await runtime.respondPermission(command.requestId, command.optionId);
  } else {
    if (!pending.pendingQuestions.some((e) => e.data.requestId === command.requestId) || !runtime.hasPendingQuestion?.(command.requestId)) throw new MobileControlError('pending_request_not_found');
    await runtime.answerQuestion(command.requestId, command.answers);
  }
  return { answered: true, requestId: command.requestId };
}

/** The composer's model and effort pills (#2462): only what they would offer. */
async function setModel(command: Extract<MobileCommand, { type: 'chat.setModel' }>, runtime: AgentRuntime, now: MobileChatControls) {
  if (!runtime.setModel) throw new MobileControlError('model_switch_not_supported');
  const switching = command.model !== now.model;
  if (switching && (now.modelSwitch === 'none' || now.models.length === 0)) throw new MobileControlError('model_switch_not_supported');
  if (switching && !now.models.some((m) => m.id === command.model)) throw new MobileControlError('unknown_model');
  let effort = command.effort;
  if (effort !== undefined && now.effortSwitch === 'none') throw new MobileControlError('effort_switch_not_supported');
  if (effort === null && !now.effortDefault) throw new MobileControlError('effort_default_not_supported');
  // The current model's list; another model's efforts are only known once it runs.
  if (typeof effort === 'string' && !switching && !now.efforts.includes(effort)) throw new MobileControlError('unknown_effort');
  // Omitted, as the model menu does: keep a chosen effort the list still offers; a default one follows the new model's default.
  if (effort === undefined && switching) effort = now.effort && !now.effortIsDefault && now.efforts.includes(now.effort) ? now.effort : undefined;
  if (!switching && effort === undefined) return { model: command.model, effort: now.effortIsDefault ? null : now.effort, changed: false };
  await runtime.setModel(command.model, effort);
  return { model: command.model, effort: effort ?? null, changed: true };
}

/** The composer's level menu (#2462): any level the driver switches to live. A paired phone has full control. */
async function setLevel(command: Extract<MobileCommand, { type: 'chat.setLevel' }>, runtime: AgentRuntime, now: MobileChatControls) {
  if (!runtime.setLevel) throw new MobileControlError('level_switch_not_supported');
  if (command.level === now.level) return { level: command.level, changed: false };
  if (!now.liveLevels.includes(command.level)) throw new MobileControlError('level_not_live');
  await runtime.setLevel(command.level);
  return { level: command.level, changed: true };
}
