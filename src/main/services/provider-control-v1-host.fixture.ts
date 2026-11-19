/** Test-only frozen validator/service from supplied base cab7f509564c395df1c0fd7869bd04812c91cb97.
 * Body from MobileControlError through MobileCommandService is unchanged; unused imports removed.
 * Body SHA256: 5fc7b4a7394ec0ef9c559970c98065c44ecba2625d97158020456b9a52743bfa
 * Current command-name/type imports are unchanged from that base. No legacy host binary is run. */
import { AgentResumeError, AgentTransitionError } from './agent-transition';
import { withSettingsSurface, type SettingsAuditSurface } from './settings-audit';
import { createHash, randomUUID } from 'crypto';
import { CHAT_ATTACHMENTS_MAX, PERMISSION_LEVELS } from '../../shared/chat';
import { MOBILE_COMMAND_TYPES, MOBILE_GRANT_ANSWERS, type MobileCommand, type MobileResponse } from '../../shared/mobile-control';
import { AGENT_IDLE_SLEEP_MINUTES } from '../../shared/idle-sleep';

export class MobileControlError extends Error {
  /** `detail` is a sentence for the user (e.g. why a name was refused); the receipt's message falls back to the code. */
  constructor(
    readonly code: string,
    readonly statusCode = 409,
    readonly outcome: 'rejected' | 'failed' = 'rejected',
    readonly detail?: string,
    /** Fields for the refusal's body, such as fresh values for a stale write. */
    readonly extra?: Record<string, unknown>,
  ) { super(code); }
}

/** Every field each command accepts besides version, commandId, epoch and type; anything else is invalid_command. */
export const MOBILE_COMMAND_FIELDS: Readonly<Record<MobileCommand['type'], readonly string[]>> = {
  'chat.send': ['agentId', 'sessionId', 'text', 'delivery', 'attachmentIds'],
  'chat.interrupt': ['agentId', 'sessionId'],
  'chat.queue.remove': ['agentId', 'sessionId', 'messageIds'],
  'chat.permission': ['agentId', 'sessionId', 'requestId', 'optionId', 'reviewedDigest'],
  'chat.question': ['agentId', 'sessionId', 'requestId', 'answers'],
  'chat.setModel': ['agentId', 'sessionId', 'model', 'effort'],
  'chat.setLevel': ['agentId', 'sessionId', 'level'],
  'agent.start': ['agentId', 'message', 'resume', 'expectedProvider', 'expectedSessionId'],
  'agent.stop': ['agentId', 'waitForStopped'],
  'agent.providerPreview': ['agentId', 'provider'],
  'agent.providerChange': ['agentId', 'provider', 'expectedState'],
  'agent.spawn': ['projectId', 'prompt', 'model', 'orchestrator'],
  'agent.create': ['managed', 'templateId', 'blank', 'projectId', 'name', 'color', 'orchestrator', 'model', 'persona', 'freeAgentMode', 'access', 'useWorktree', 'mcpIds', 'branchName', 'branchFrom', 'folderName', 'orchestration'],
  'agent.update': ['agentId', 'name', 'color', 'emoji', 'orchestrator', 'model', 'runtime', 'persona', 'clubhouseMode', 'freeAgentMode', 'access', 'idleSleep', 'contextWindow', 'orchestration'],
  'project.setPinned': ['projectId', 'pinned'],
  'project.setInactive': ['projectId', 'inactive'],
  'helper.approve': ['requestId', 'force'],
  'helper.decline': ['requestId'],
  'grant.answer': ['requestId', 'answer', 'updateMode', 'reviewedDigest'],
  'app.update.check': [],
  'app.update.request': [],
  'app.update.cancel': ['requestId'],
  'quick.dismiss': ['projectId', 'agentId'],
  'quick.clear': ['projectId'],
  'dispatcher.setEnabled': ['enabled'],
  'dispatcher.update': ['behavior', 'name', 'color', 'emoji', 'personality'],
  'dispatcher.setModels': ['byHand', 'role', 'provider', 'model', 'effort', 'contextWindow'],
  'dispatcher.clearChat': ['expectedState'],
  'dispatcher.forgetEverything': ['expectedState'],
  'helperRouting.update': ['revision', 'scope', 'projectId', 'cells', 'reset', 'auto', 'copilotAuto'],
};
/** Fields a command may leave out. Every agent.update setting is optional, but it needs at least one. */
const OPTIONAL = new Set(['reviewedDigest', 'delivery', 'message', 'resume', 'model', 'orchestrator', 'attachmentIds', 'force', 'effort', 'cells', 'reset', 'expectedProvider', 'expectedSessionId', 'waitForStopped', 'updateMode']);
const ROUTING_OPTIONAL = new Set(['projectId', 'auto', 'copilotAuto']);
const CREATE_OPTIONAL = new Set(['managed', 'templateId', 'blank', 'orchestrator', 'model', 'persona', 'freeAgentMode', 'access', 'useWorktree', 'mcpIds', 'branchName', 'branchFrom', 'folderName', 'orchestration']);
/** Commands whose fields are all optional, with at least one set: Settings > Dispatcher's (#3206). */
const ANY_OF = new Set<string>(['dispatcher.update', 'dispatcher.setModels']);
export const isOptionalCommandField = (type: MobileCommand['type'], key: string): boolean =>
  ANY_OF.has(type) ? true : type === 'agent.update' ? key !== 'agentId' : type === 'agent.create' ? CREATE_OPTIONAL.has(key)
    : type === 'helperRouting.update' && ROUTING_OPTIONAL.has(key) ? true
      : type === 'chat.setModel' && key === 'model' ? false : OPTIONAL.has(key);
const BOOLEAN_FIELDS = new Set(['managed', 'blank', 'waitForStopped', 'resume', 'useWorktree', 'clubhouseMode', 'pinned', 'inactive', 'force', 'freeAgentMode', 'enabled', 'byHand', 'copilotAuto']);
/** Fields agent.update clears with null. */
export const NULLABLE_ON_UPDATE = new Set(['emoji', 'persona', 'orchestration', 'contextWindow']);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const idleSleep = (v: unknown): boolean => v === 'inherit' || v === 'never' || (AGENT_IDLE_SLEEP_MINUTES as readonly unknown[]).includes(v);
export function parseMobileCommand(value: unknown): MobileCommand {
  if (!record(value)) throw new MobileControlError('invalid_command', 400);
  if (value.version !== 1) throw new MobileControlError('unsupported_version', 400);
  if (!text(value.commandId, 128) || !text(value.epoch, 128) || !MOBILE_COMMAND_TYPES.includes(value.type as MobileCommand['type'])) throw new MobileControlError('invalid_command', 400);
  const type = value.type as MobileCommand['type'];
  const fields = MOBILE_COMMAND_FIELDS[type];
  if (Object.keys(value).some((k) => !['version', 'commandId', 'epoch', 'type', ...fields].includes(k))) throw new MobileControlError('invalid_command', 400);
  for (const key of fields) {
    const v = value[key];
    if (isOptionalCommandField(type, key) && v === undefined) continue;
    if ((type === 'agent.update' || ANY_OF.has(type)) && NULLABLE_ON_UPDATE.has(key) && v === null) continue;
    if (BOOLEAN_FIELDS.has(key)) { if (typeof v !== 'boolean') throw new MobileControlError('invalid_command', 400); }
    else if (key === 'attachmentIds') {
      if (!Array.isArray(v) || v.length === 0 || v.length > CHAT_ATTACHMENTS_MAX || v.some((id) => !text(id, 128)) || new Set(v).size !== v.length) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'text' && value.type === 'chat.send' && v === '' && value.attachmentIds !== undefined) continue; // image-only message
    else if (key === 'messageIds') {
      if (!Array.isArray(v) || v.length === 0 || v.length > 1000 || v.some((id) => !text(id, 128))) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'mcpIds') {
      if (!Array.isArray(v) || v.length > 100 || v.some((id) => !text(id, 128)) || new Set(v).size !== v.length) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'answers') {
      // A Claude question's id is its full text (claudeQuestions), so ids get the same limit as answers. They stay exactly as sent.
      if (!record(v) || Object.keys(v).length > 100 || Object.entries(v).some(([k, a]) => !text(k, 65536) || !(text(a, 65536) || (Array.isArray(a) && a.length <= 100 && a.every((x) => text(x, 65536)))))) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'orchestration') {
      // The fields are checked against the policy rules (and the app-wide cap) when the command runs, so errors can say why.
      if (!record(v) || Object.keys(v).length > 16) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'cells') {
      // Checked against the presets rules when the command runs, so errors can say why.
      if (!Array.isArray(v) || v.length === 0 || v.length > 32 || v.some((c) => !record(c))) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'personality') {
      // Checked against the personality rules when the command runs, so errors can say why.
      if (!record(v) || Object.keys(v).length === 0 || Object.keys(v).some((k) => k !== 'preset' && k !== 'text')) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'reset') {
      if (!record(v) || Object.keys(v).length > 2) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'auto') {
      if (v !== true && v !== false && v !== 'off' && v !== null) throw new MobileControlError('invalid_command', 400);
    } else if (key === 'idleSleep') { if (!idleSleep(v)) throw new MobileControlError('invalid_command', 400); }
    else if (key === 'effort') { if (v !== null && !text(v, 64)) throw new MobileControlError('invalid_command', 400); }
    else if (key === 'level' || key === 'access') { if (!(PERMISSION_LEVELS as readonly unknown[]).includes(v)) throw new MobileControlError('invalid_command', 400); }
    else if (key === 'answer') { if (!(MOBILE_GRANT_ANSWERS as readonly unknown[]).includes(v)) throw new MobileControlError('invalid_command', 400); }
    else if (key === 'updateMode') { if (v !== 'now' && v !== 'when_idle') throw new MobileControlError('invalid_command', 400); }
    else if (key === 'runtime') { if (!['default', 'chat', 'terminal'].includes(v as string)) throw new MobileControlError('invalid_command', 400); }
    else if (!text(v, ['text', 'message', 'prompt'].includes(key) ? 65536 : key === 'emoji' ? 16 : 256)) throw new MobileControlError('invalid_command', 400);
  }
  if (value.delivery !== undefined && !['auto', 'prompt', 'steer', 'queued'].includes(value.delivery as string)) throw new MobileControlError('invalid_command', 400);
  if ((type === 'agent.update' || ANY_OF.has(type)) && !fields.some((k) => k !== 'agentId' && value[k] !== undefined)) throw new MobileControlError('invalid_command', 400);
  if (type === 'helperRouting.update' && value.cells === undefined && value.reset === undefined && value.auto === undefined && value.copilotAuto === undefined) throw new MobileControlError('invalid_command', 400);
  if (type === 'agent.start' && value.expectedSessionId !== undefined && (value.resume !== true || !text(value.expectedProvider))) throw new MobileControlError('invalid_command', 400);
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
  /** `surface` is the controlling device's kind for the audit: `mobile` for a phone, `annex_desktop` for another computer. */
  async execute(principal: string | undefined, input: unknown, run: (command: MobileCommand) => Promise<unknown>, surface: SettingsAuditSurface = 'mobile'): Promise<MobileResponse> {
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
        const result = await withSettingsSurface(surface, principal, () => run(command));
        return { statusCode: 200, body: { version: 1 as const, commandId: command.commandId, epoch, status: 'completed' as const, result } };
      } catch (err) {
        // telemetry-exempt: the receipt reports failure; runtime operations own detailed error telemetry.
        const failure = err instanceof AgentTransitionError || err instanceof AgentResumeError ? new MobileControlError(err.code) : err;
        const known = failure instanceof MobileControlError;
        const code = known ? failure.code : 'command_failed';
        const message = known && failure.detail ? failure.detail : code;
        return { statusCode: known ? failure.statusCode : 500, body: { version: 1 as const, commandId: command.commandId, epoch, status: known ? failure.outcome : 'failed' as const, error: { code, message }, ...(known && failure.extra) } };
      } finally { entry.settled = true; entry.expires = this.now() + MOBILE_COMMAND_TTL_MS; }
    }) };
    this.entries.set(key, entry);
    return entry.response;
  }
}

