import type { ChildProcess } from 'child_process';
import type { ClaudePermissionMode } from './events';
import { initializedFromWire, permissionRequestFromWire, type ClaudeWireMessage } from './normalizer';
import { killStructuredChild } from '../../orchestrators/adapters/structured-spawn';
import { buildClaudeEnv, spawnClaude } from './spawn';
import {
  appliedSettingsFromWire,
  ClaudeTransportBase,
  toWireUserMessage,
  type ClaudeAppliedSettings,
  type ClaudeEffort,
  type ClaudeTransportOptions,
  type ClaudeUserInput,
} from './transport';

const CONTROL_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 5_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Arguments for `claude -p` in stream-json mode with the control protocol on
 * stdio. Mirrors what the Agent SDK passes, so a session behaves the same
 * through either transport.
 */
export function buildStreamJsonArgs(opts: ClaudeTransportOptions): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    // Undocumented in --help; the SDK passes it to route can_use_tool over stdio.
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', opts.permissionMode,
  ];
  if (opts.permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
  if (opts.includePartialMessages ?? true) args.push('--include-partial-messages');
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
  }
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.resume && opts.forkSession) args.push('--fork-session');
  if (opts.resume && opts.resumeSessionAt) args.push('--resume-session-at', opts.resumeSessionAt);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.disallowedTools?.length) args.push('--disallowedTools', opts.disallowedTools.join(','));
  for (const dir of opts.additionalDirectories ?? []) args.push('--add-dir', dir);
  return args;
}

interface PendingControl {
  subtype: string;
  resolve: (response: Obj) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Second Claude chat transport: spawns the user's `claude -p` with NDJSON in
 * and out and speaks the control protocol directly
 * (docs/structured-chat-research.md §7 "StreamTransport"). No SDK dependency,
 * so it keeps working if an SDK release breaks or packaging terms change.
 */
export class ClaudeStreamTransport extends ClaudeTransportBase {
  readonly kind = 'stream-json' as const;
  private child: ChildProcess | null = null;
  private stdoutBuf = '';
  private nextRequestId = 1;
  private readonly pendingControl = new Map<string, PendingControl>();
  private exited: Promise<void> = Promise.resolve();

  constructor(
    opts: ClaudeTransportOptions,
    /** Injectable for tests. */
    private readonly spawnFn: typeof spawnClaude = spawnClaude,
  ) {
    super(opts);
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('Claude stream transport already started');
    const { opts } = this;
    const args = buildStreamJsonArgs(opts);
    this.log('info', 'Spawning claude -p stream-json', {
      binary: opts.binary, cwd: opts.cwd, permissionMode: opts.permissionMode, resume: opts.resume,
    });
    const child = this.spawnFn({
      binary: opts.binary,
      args,
      cwd: opts.cwd,
      env: buildClaudeEnv(opts.env),
      commandPrefix: opts.commandPrefix,
    });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr?.on('data', (d: Buffer) => this.log('warn', 'claude stderr', { data: d.toString().slice(0, 2000) }));
    // 'exit' can fire before stdout is drained, so it only records the status;
    // teardown waits for 'close', after all stdio has ended.
    let exitStatus: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    child.on('exit', (code, signal) => { exitStatus = { code, signal }; });
    this.exited = new Promise((resolve) => {
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        this.onStdout('\n'); // flush a final unterminated line
        const status = { code: code ?? exitStatus.code, signal: signal ?? exitStatus.signal };
        this.failPendingControl(new Error(`claude exited (code ${status.code}, signal ${status.signal})`));
        this.end(status.code, status.signal);
        resolve();
      });
    });
    child.on('error', (err) => {
      this.log('error', 'claude process error', { error: err.message });
      this.pushEvent({ kind: 'error', message: err.message, fatal: true });
      this.failPendingControl(err);
      this.end(null, null, err.message);
    });
    child.stdin?.on('error', (err) => this.log('warn', 'claude stdin error', { error: err.message }));

    const init = await this.control({ subtype: 'initialize' });
    this.pushEvent(initializedFromWire(init));
  }

  send(input: ClaudeUserInput): void {
    this.requireRunning();
    this.write(toWireUserMessage(input, this.sessionId));
  }

  async interrupt(): Promise<void> {
    await this.control({ subtype: 'interrupt' });
  }

  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    await this.control({ subtype: 'set_permission_mode', mode });
  }

  async setModel(model?: string): Promise<void> {
    await this.control({ subtype: 'set_model', ...(model ? { model } : {}) });
  }

  async setEffort(effort: ClaudeEffort): Promise<void> {
    await this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
  }

  async appliedSettings(): Promise<ClaudeAppliedSettings> {
    return appliedSettingsFromWire(await this.control({ subtype: 'get_settings' }));
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.isEnded) return;
    child.stdin?.end();
    const exited = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), CLOSE_GRACE_MS).unref?.()),
    ]);
    if (!exited) {
      this.log('warn', 'claude did not exit after stdin closed; killing');
      await killStructuredChild(child);
      await this.exited;
    }
  }

  /** Send a host → CLI control request and wait for its control_response. */
  private control(request: Obj & { subtype: string }, timeoutMs = CONTROL_TIMEOUT_MS): Promise<Obj> {
    this.requireRunning();
    const requestId = `clubhouse-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error(`Claude control request '${request.subtype}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingControl.set(requestId, { subtype: request.subtype, resolve, reject, timer });
      this.write({ type: 'control_request', request_id: requestId, request });
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log('warn', 'Malformed stream-json line from claude', { line: line.slice(0, 500) });
      return;
    }
    if (!isObj(msg) || typeof msg.type !== 'string') {
      this.log('warn', 'stream-json line without a type', { line: line.slice(0, 500) });
      return;
    }
    switch (msg.type) {
      case 'control_response':
        this.onControlResponse(msg);
        return;
      case 'control_request':
        this.onControlRequest(msg);
        return;
      case 'control_cancel_request':
        if (typeof msg.request_id === 'string') this.cancelPermission(msg.request_id);
        return;
      default:
        this.pushWire(msg as ClaudeWireMessage);
    }
  }

  private onControlResponse(msg: Obj): void {
    const response = isObj(msg.response) ? msg.response : {};
    const requestId = typeof response.request_id === 'string' ? response.request_id : '';
    const pending = this.pendingControl.get(requestId);
    if (!pending) {
      this.log('warn', 'Unmatched control_response', { requestId });
      return;
    }
    this.pendingControl.delete(requestId);
    clearTimeout(pending.timer);
    if (response.subtype === 'success') {
      pending.resolve(isObj(response.response) ? response.response : {});
    } else {
      pending.reject(new Error(`Claude control request '${pending.subtype}' failed: ${String(response.error ?? 'unknown error')}`));
    }
  }

  /** CLI → host requests: `can_use_tool` today; anything else is declined so the CLI never hangs. */
  private onControlRequest(msg: Obj): void {
    const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
    const request = isObj(msg.request) ? msg.request : {};
    if (request.subtype === 'can_use_tool') {
      const body = permissionRequestFromWire(requestId, request);
      if (body.kind !== 'permission_request') return;
      // A request the CLI cancelled (control_cancel_request) gets no response.
      void this.awaitPermission(body).then((result) => { if (result) this.respondControl(requestId, result); });
      return;
    }
    this.log('warn', 'Unsupported control request from claude', { subtype: request.subtype });
    this.respondControlError(requestId, `Clubhouse does not handle '${String(request.subtype)}'`);
  }

  private respondControl(requestId: string, response: Obj): void {
    if (this.isEnded) return;
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  private respondControlError(requestId: string, error: string): void {
    if (this.isEnded) return;
    this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
  }

  private failPendingControl(err: Error): void {
    for (const [id, pending] of this.pendingControl) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingControl.delete(id);
    }
  }

  private write(obj: Obj): void {
    this.child?.stdin?.write(JSON.stringify(obj) + '\n');
  }

  private requireRunning(): void {
    if (!this.child || this.isEnded) throw new Error('Claude stream-json session is not running');
  }
}
