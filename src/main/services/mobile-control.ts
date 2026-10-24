import { createHash, randomUUID } from 'crypto';
import type { AgentRuntime, ChatEvent } from '../../shared/chat';
import { MOBILE_COMMAND_TYPES, type MobileCommand, type MobileResponse } from '../../shared/mobile-control';

export class MobileControlError extends Error {
  constructor(readonly code: string, readonly statusCode = 409, readonly outcome: 'rejected' | 'failed' = 'rejected') { super(code); }
}

const FIELDS: Record<MobileCommand['type'], string[]> = {
  'chat.send': ['agentId', 'sessionId', 'text', 'delivery'],
  'chat.interrupt': ['agentId', 'sessionId'],
  'chat.queue.remove': ['agentId', 'sessionId', 'messageIds'],
  'chat.permission': ['agentId', 'sessionId', 'requestId', 'optionId'],
  'chat.question': ['agentId', 'sessionId', 'requestId', 'answers'],
  'agent.start': ['agentId', 'message', 'resume'],
  'agent.stop': ['agentId'],
  'agent.spawn': ['projectId', 'prompt', 'model', 'orchestrator'],
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export function parseMobileCommand(value: unknown): MobileCommand {
  if (!record(value)) throw new MobileControlError('invalid_command', 400);
  if (value.version !== 1) throw new MobileControlError('unsupported_version', 400);
  if (!text(value.commandId, 128) || !text(value.epoch, 128) || !MOBILE_COMMAND_TYPES.includes(value.type as MobileCommand['type'])) throw new MobileControlError('invalid_command', 400);
  const fields = FIELDS[value.type as MobileCommand['type']];
  if (Object.keys(value).some((k) => !['version', 'commandId', 'epoch', 'type', ...fields].includes(k))) throw new MobileControlError('invalid_command', 400);
  for (const key of fields) {
    const v = value[key];
    if (['delivery', 'message', 'resume', 'model', 'orchestrator'].includes(key) && v === undefined) continue;
    if (key === 'resume') { if (typeof v !== 'boolean') throw new MobileControlError('invalid_command', 400); }
    else if (key === 'messageIds') {
      if (!Array.isArray(v) || v.length === 0 || v.length > 1000 || v.some((id) => !text(id, 128))) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'answers') {
      if (!record(v) || Object.keys(v).length > 100 || Object.entries(v).some(([k, a]) => !text(k) || !(text(a, 65536) || (Array.isArray(a) && a.length <= 100 && a.every((x) => text(x, 65536)))))) throw new MobileControlError('invalid_command', 400);
    } else if (!text(v, ['text', 'message', 'prompt'].includes(key) ? 65536 : 256)) throw new MobileControlError('invalid_command', 400);
  }
  if (value.delivery !== undefined && !['auto', 'prompt', 'steer', 'queued'].includes(value.delivery as string)) throw new MobileControlError('invalid_command', 400);
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
        return { statusCode: known ? err.statusCode : 500, body: { version: 1 as const, commandId: command.commandId, epoch, status: known ? err.outcome : 'failed' as const, error: { code, message: code } } };
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

export async function executeChatCommand(command: Extract<MobileCommand, { sessionId: string }>, runtime: AgentRuntime | undefined, canSend: () => Promise<boolean>, assertCurrent: () => void = () => {}): Promise<unknown> {
  assertCurrent();
  if (!runtime || runtime.kind !== 'chat' || !runtime.isRunning()) throw new MobileControlError('not_chat');
  if (runtime.getSessionId?.() !== command.sessionId) throw new MobileControlError('session_mismatch');
  if (command.type === 'chat.send') {
    if (!await canSend()) throw new MobileControlError('revert_in_progress');
    assertCurrent();
    // A session can change while waiting for a revert check.
    if (runtime.getSessionId?.() !== command.sessionId) throw new MobileControlError('session_mismatch');
    return runtime.sendMessage([{ type: 'text', text: command.text }], { source: 'annex', delivery: command.delivery ?? 'auto', clientCommandId: command.commandId });
  }
  if (command.type === 'chat.interrupt') { await runtime.interrupt(); return { interrupted: true }; }
  if (command.type === 'chat.queue.remove') {
    if (!runtime.removeQueued) throw new MobileControlError('queue_removal_not_supported');
    return { removed: await runtime.removeQueued(command.messageIds) };
  }
  const { events = [] } = await runtime.readTranscript();
  assertCurrent();
  if (runtime.getSessionId?.() !== command.sessionId) throw new MobileControlError('session_mismatch');
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
