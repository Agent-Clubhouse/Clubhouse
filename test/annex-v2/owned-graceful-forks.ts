import * as fs from 'fs';
import * as path from 'path';
import { ForksPoolWorker, type PoolOptions, type WorkerRequest } from 'vitest/node';

type NativeEnd = { code: unknown; signal: unknown };
let instances = 0;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class OwnedGracefulForks extends ForksPoolWorker {
  readonly name = 'owned-graceful-forks';
  private readonly role: 'A' | 'B';
  private readonly nonce: string;
  private readonly eventPath: string;
  private requested = false;
  private acknowledgment?: Record<string, unknown>;
  private nativeExit?: NativeEnd;
  private nativeClose?: NativeEnd;
  private premature = false;
  private releaseClose!: () => void;
  private readonly closed = new Promise<void>((resolve) => { this.releaseClose = resolve; });

  constructor(options: PoolOptions) {
    super(options);
    const role = options.env.CLUBHOUSE_ANNEX_OWNED_ROLE;
    const nonce = options.env.CLUBHOUSE_ANNEX_OWNED_NONCE;
    const auditPath = options.env.CLUBHOUSE_ANNEX_OWNED_AUDIT;
    if (options.env.CLUBHOUSE_ANNEX_OWNED_EXIT !== '1' || (role !== 'A' && role !== 'B') || !nonce || !auditPath) {
      throw new Error('Graceful pool requires an owned peer identity');
    }
    const output = path.dirname(auditPath);
    if (path.dirname(output) !== path.resolve('node_modules/.cache/p8-evidence')
      || !path.basename(output).startsWith('owned-exit-')) throw new Error('Invalid graceful pool artifact directory');
    this.role = role;
    this.nonce = nonce;
    this.eventPath = path.join(output, `${role}-native-events.jsonl`);
    instances++;
    this.emitRecord('pool-created', { instances });
    if (instances !== 1) throw new Error('Owned pool must have exactly one unreplaced fork per CLI');
  }

  private emitRecord(kind: string, details: Record<string, unknown>) {
    fs.appendFileSync(this.eventPath, JSON.stringify({
      kind, role: this.role, nonce: this.nonce, cliPid: process.pid, utc: new Date().toISOString(), ...details,
    }) + '\n');
  }

  async start() {
    await super.start();
    this.on('message', (value: unknown) => {
      if (!record(value) || value.__vitest_worker_response__ !== true || value.type !== 'stopped') return;
      if (this.acknowledgment) throw new Error('Duplicate graceful stop acknowledgment');
      this.acknowledgment = value;
      this.emitRecord('runtime-stopped', { response: value });
    });
    this.on('exit', (code: unknown, signal?: unknown) => {
      this.nativeExit = { code, signal };
      this.premature = !this.requested || !this.acknowledgment;
      this.emitRecord('native-exit', { code, signal, premature: this.premature });
    });
    this.on('close', (code: unknown, signal?: unknown) => {
      this.nativeClose = { code, signal };
      this.emitRecord('native-close', { code, signal });
      this.releaseClose();
    });
  }

  send(message: WorkerRequest) {
    if (message.type === 'stop') {
      if (this.requested) throw new Error('Duplicate graceful stop request');
      this.requested = true;
      this.emitRecord('stop-request', { tagged: message.__vitest_worker_request__ });
    }
    super.send(message);
  }

  async stop() {
    if (!this.requested || !this.acknowledgment || this.acknowledgment.error !== undefined) {
      throw new Error('Owned fork did not complete the unchanged graceful stop protocol');
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Owned fork did not exit naturally and close stdio within20s')), 20_000);
        }),
      ]);
    } finally { clearTimeout(timer); }
    if (!this.nativeExit || !this.nativeClose || this.premature
      || this.nativeExit.code !== 0 || this.nativeExit.signal !== null
      || this.nativeClose.code !== 0 || this.nativeClose.signal !== null) {
      throw new Error('Owned fork native exit/close was not an acknowledged natural0/null exit');
    }
    // The native exit/close events precede this cleanup; no live child is signaled.
    this.emitRecord('dead-cleanup-start', {});
    await super.stop();
    this.emitRecord('dead-cleanup-complete', {});
  }
}
