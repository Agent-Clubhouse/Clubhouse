/**
 * One prompt, one answer: runs a provider's headless command for a short
 * piece of text and returns what the model said. No agent, no session kept,
 * no Clubhouse MCP, no transcript. For small background steps such as the
 * Dispatcher's rewrite of an agent's message (#3043).
 *
 * It spends tokens, so tests run it against a fake CLI (a script that prints
 * the provider's output format) and never a real model.
 */
import { spawn as cpSpawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getProvider } from '../orchestrators/registry';
import { isHeadlessCapable, type HeadlessCommandResult, type OrchestratorProvider } from '../orchestrators/types';
import { resolveStructuredSpawn } from '../orchestrators/adapters/structured-spawn';
import { cleanSpawnEnv, getShellEnvironment } from '../util/shell';
import type { StreamJsonEvent } from './jsonl-parser';

export interface HeadlessPromptRequest {
  provider: string;
  model: string;
  /** Null passes no level, so the CLI picks. */
  effort?: string | null;
  prompt: string;
  timeoutMs?: number;
}

export type HeadlessPromptResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export interface HeadlessPromptDeps {
  provider?: (id: string) => OrchestratorProvider | undefined;
  spawn?: (binary: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => ChildProcess;
  /** An empty folder to run in, so no project's instructions are read. */
  workDir?: () => string;
}

export const HEADLESS_PROMPT_TIMEOUT_MS = 30_000;
/** Tools a CLI that takes the list is told not to use. */
const NO_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'];
/** More output than a short answer could need: stop reading. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function defaultWorkDir(): string {
  const dir = path.join(os.tmpdir(), 'clubhouse-headless-prompt');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultSpawn(binary: string, args: string[], opts: { cwd: string; env: Record<string, string> }): ChildProcess {
  const cmd = resolveStructuredSpawn(binary, args);
  return cpSpawn(cmd.binary, cmd.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cmd.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
  });
}

/** Text blocks of an assistant message, joined. */
function assistantText(event: StreamJsonEvent): string {
  const content = event.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * The answer in a headless run's output. Text output is the answer as it
 * stands. Stream-json takes the `result` event's text, or else the last
 * assistant message. Lines that aren't JSON are skipped.
 */
export function headlessAnswer(output: string, command: Pick<HeadlessCommandResult, 'outputKind' | 'createEventNormalizer'>): string {
  if (command.outputKind === 'text') return output.trim();
  const normalize = command.createEventNormalizer?.();
  let result: string | undefined;
  let lastAssistant = '';
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let raw: StreamJsonEvent;
    try {
      raw = JSON.parse(trimmed) as StreamJsonEvent;
    } catch {
      // telemetry-exempt: a line that isn't JSON is CLI chatter, not the answer
      continue;
    }
    for (const event of normalize ? normalize(raw) : [raw]) {
      if (event.type === 'result' && typeof event.result === 'string' && !event.is_error) result = event.result;
      if (event.type === 'assistant') {
        const text = assistantText(event);
        if (text.trim()) lastAssistant = text;
      }
    }
  }
  return (result ?? lastAssistant).trim();
}

/** Run one prompt on a provider's model and return its answer. Never throws. */
export async function runHeadlessPrompt(req: HeadlessPromptRequest, deps: HeadlessPromptDeps = {}): Promise<HeadlessPromptResult> {
  const provider = (deps.provider ?? getProvider)(req.provider);
  if (!provider || !isHeadlessCapable(provider)) return { ok: false, error: `${req.provider} can't run a one-off prompt.` };
  let cwd: string;
  let command: HeadlessCommandResult | null;
  try {
    cwd = (deps.workDir ?? defaultWorkDir)();
    command = await provider.buildHeadlessCommand({
      cwd,
      model: req.model,
      ...(req.effort && { effort: req.effort }),
      mission: req.prompt,
      noSessionPersistence: true,
      // A short answer needs no tools, and the prompt may quote text an agent wrote.
      disallowedTools: NO_TOOLS,
      permissionMode: 'auto',
    });
  } catch (err) {
    // telemetry-exempt: returned to the caller, which falls back and logs
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!command) return { ok: false, error: `${req.provider} gave no command for the prompt.` };
  const built = command;

  return new Promise<HeadlessPromptResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = (deps.spawn ?? defaultSpawn)(built.binary, built.args, { cwd, env: cleanSpawnEnv({ ...getShellEnvironment(), ...built.env }) });
    } catch (err) {
      // telemetry-exempt: returned to the caller, which falls back and logs
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let out = '';
    let bytes = 0;
    let settled = false;
    const finish = (result: HeadlessPromptResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc.exitCode === null && !proc.killed) proc.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'It took too long.' }), req.timeoutMs ?? HEADLESS_PROMPT_TIMEOUT_MS);
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) return finish({ ok: false, error: 'It answered with far more than was asked for.' });
      out += chunk;
    });
    // Drained so a chatty CLI can't block on a full pipe.
    proc.stderr?.resume();
    proc.on('error', (err) => finish({ ok: false, error: err.message }));
    proc.on('close', (code) => {
      const text = headlessAnswer(out, built);
      if (text) finish({ ok: true, text });
      else finish({ ok: false, error: code === 0 ? 'It gave no answer.' : `It exited with code ${code}.` });
    });
  });
}
