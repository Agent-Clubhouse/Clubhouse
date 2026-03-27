import { buildAssistantInstructions } from './system-prompt';
import type { FeedItem } from './types';

// ── Types ──────────────────────────────────────────────────────────────────

export type AssistantStatus = 'idle' | 'starting' | 'active' | 'responding' | 'error';
export type AssistantMode = 'interactive' | 'structured' | 'headless';

interface AssistantState {
  status: AssistantStatus;
  mode: AssistantMode;
  orchestrator: string | null;
  agentId: string | null;
  error: string | null;
  pendingText: string;
}

type Listener = (items: FeedItem[]) => void;
type StatusListener = (status: AssistantStatus, error: string | null) => void;
type ModeListener = (mode: AssistantMode) => void;
type OrchestratorListener = (orchestrator: string | null) => void;

// ── State ──────────────────────────────────────────────────────────────────

let state: AssistantState = {
  status: 'idle', mode: 'interactive', orchestrator: null,
  agentId: null, error: null, pendingText: '',
};

let nextMsgId = 1;
const feedListeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
const modeListeners = new Set<ModeListener>();
const orchestratorListeners = new Set<OrchestratorListener>();
const pendingItems: FeedItem[] = [];
let cleanupListeners: Array<() => void> = [];
let messageQueue: string[] = [];
let ptyAccumulator = '';
let ptyIdleTimer: ReturnType<typeof setTimeout> | null = null;

// ── Logging ────────────────────────────────────────────────────────────────

function log(msg: string, data?: Record<string, unknown>): void {
  if (data) console.log(`[assistant] ${msg}`, data);
  else console.log(`[assistant] ${msg}`);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string { return `assistant-msg-${nextMsgId++}`; }

function setStatus(status: AssistantStatus, error: string | null = null): void {
  state.status = status;
  state.error = error;
  log(`status -> ${status}`, error ? { error } : undefined);
  for (const listener of statusListeners) listener(status, error);
}

function pushItem(item: FeedItem): void { pendingItems.push(item); notifyFeedListeners(); }

function notifyFeedListeners(): void {
  const snapshot = [...pendingItems];
  for (const listener of feedListeners) listener(snapshot);
}

function pushAssistantMessage(text: string): void {
  pushItem({ type: 'message', message: { id: generateId(), role: 'assistant', content: text, timestamp: Date.now() } });
}

function cleanupAll(): void {
  for (const fn of cleanupListeners) fn();
  cleanupListeners = [];
  if (ptyIdleTimer) { clearTimeout(ptyIdleTimer); ptyIdleTimer = null; }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// ── Structured Events ──────────────────────────────────────────────────────

function handleStructuredEvent(agentId: string, event: { type: string; timestamp: number; data: any }): void {
  if (agentId !== state.agentId) return;
  log('structured event', { type: event.type });
  switch (event.type) {
    case 'text_delta': {
      state.pendingText += event.data.text;
      const last = pendingItems[pendingItems.length - 1];
      if (last?.type === 'message' && last.message?.role === 'assistant' && last.message.id.startsWith('streaming-')) {
        last.message.content = state.pendingText; notifyFeedListeners();
      } else {
        pendingItems.push({ type: 'message', message: { id: 'streaming-' + generateId(), role: 'assistant', content: state.pendingText, timestamp: Date.now() } });
        notifyFeedListeners();
      }
      break;
    }
    case 'text_done': {
      const last = pendingItems[pendingItems.length - 1];
      if (last?.type === 'message' && last.message?.role === 'assistant' && last.message.id.startsWith('streaming-')) {
        last.message.content = event.data.text; last.message.id = generateId(); notifyFeedListeners();
      }
      state.pendingText = ''; setStatus('active'); break;
    }
    case 'tool_start':
      pushItem({ type: 'action', action: { id: event.data.id, toolName: event.data.displayVerb || event.data.name, description: getPrimaryInput(event.data.input), status: 'running', input: event.data.input } }); break;
    case 'tool_end': {
      const a = pendingItems.find(i => i.type === 'action' && i.action?.id === event.data.id);
      if (a?.action) { a.action.status = event.data.status === 'error' ? 'error' : 'completed'; a.action.output = event.data.result; a.action.durationMs = event.data.durationMs; if (event.data.status === 'error') a.action.error = event.data.result; notifyFeedListeners(); }
      break;
    }
    case 'error': pushAssistantMessage(`Error: ${event.data.message}`); setStatus('error', event.data.message); break;
    case 'end': state.pendingText = ''; log('session ended', { reason: event.data.reason }); setStatus(event.data.reason === 'error' ? 'error' : 'active', event.data.reason === 'error' ? event.data.summary : null); break;
  }
}

function getPrimaryInput(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'command', 'query', 'pattern', 'url', 'path']) { if (typeof input[key] === 'string') return input[key] as string; }
  return '';
}

// ── PTY Handlers ───────────────────────────────────────────────────────────

function handlePtyData(agentId: string, data: string): void {
  if (agentId !== state.agentId) return;
  ptyAccumulator += data;
  log('PTY data', { length: data.length, total: ptyAccumulator.length });
  if (ptyIdleTimer) clearTimeout(ptyIdleTimer);
  ptyIdleTimer = setTimeout(() => {
    if (ptyAccumulator.trim()) {
      const cleaned = stripAnsi(ptyAccumulator).trim();
      if (cleaned) {
        const last = pendingItems[pendingItems.length - 1];
        if (last?.type === 'message' && last.message?.role === 'assistant' && last.message.id.startsWith('streaming-')) {
          last.message.content = cleaned; last.message.id = generateId(); notifyFeedListeners();
        } else { pushAssistantMessage(cleaned); }
      }
      ptyAccumulator = '';
    }
    setStatus('active');
  }, 1500);
  const cleaned = stripAnsi(ptyAccumulator).trim();
  if (cleaned) {
    const last = pendingItems[pendingItems.length - 1];
    if (last?.type === 'message' && last.message?.role === 'assistant' && last.message.id.startsWith('streaming-')) {
      last.message.content = cleaned; notifyFeedListeners();
    } else {
      pendingItems.push({ type: 'message', message: { id: 'streaming-' + generateId(), role: 'assistant', content: cleaned, timestamp: Date.now() } });
      notifyFeedListeners();
    }
  }
}

function handlePtyExit(agentId: string, exitCode: number): void {
  if (agentId !== state.agentId) return;
  log('PTY exited', { exitCode });
  if (ptyAccumulator.trim()) { const c = stripAnsi(ptyAccumulator).trim(); if (c) pushAssistantMessage(c); ptyAccumulator = ''; }
  if (state.mode === 'headless') { readHeadlessResult(agentId); }
  else { if (exitCode !== 0) pushAssistantMessage(`_Agent exited with code ${exitCode}_`); setStatus('idle'); }
}

async function readHeadlessResult(agentId: string): Promise<void> {
  log('reading headless transcript', { agentId });
  try {
    const transcript = await window.clubhouse.agent.readTranscript(agentId);
    if (transcript) {
      const lines = transcript.split('\n').filter((l: string) => l.trim());
      let text = '';
      for (const line of lines) { try { const e = JSON.parse(line); if (e.type === 'text' || e.type === 'text_done') text = e.text || e.data?.text || text; else if (e.type === 'result') text = e.result || text; } catch { /* skip */ } }
      pushAssistantMessage(text || '_Agent completed with no text response._');
    } else { pushAssistantMessage('_No transcript available._'); }
  } catch (err) { pushAssistantMessage(`_Failed to read response: ${err instanceof Error ? err.message : String(err)}_`); }
  setStatus('idle');
}

// ── Core API ───────────────────────────────────────────────────────────────

export async function sendMessage(text: string): Promise<void> {
  pushItem({ type: 'message', message: { id: generateId(), role: 'user', content: text, timestamp: Date.now() } });
  if (state.status === 'starting') { messageQueue.push(text); return; }
  if (state.status === 'idle' || state.status === 'error') { await startAgent(text); return; }
  if (state.status === 'active' && state.agentId) {
    setStatus('responding');
    try {
      if (state.mode === 'structured') { log('sending structured message'); await window.clubhouse.agent.sendStructuredMessage(state.agentId, text); }
      else if (state.mode === 'interactive') { log('sending PTY input'); ptyAccumulator = ''; window.clubhouse.pty.write(state.agentId, text + '\n'); }
      else { await startAgent(text); }
    } catch (err) { const msg = err instanceof Error ? err.message : String(err); log('send failed', { error: msg }); pushAssistantMessage(`Failed to send: ${msg}`); setStatus('error', msg); }
  }
}

async function startAgent(firstMessage: string): Promise<void> {
  setStatus('starting');
  try {
    const availability = await window.clubhouse.agent.checkOrchestrator(undefined, state.orchestrator || undefined);
    log('orchestrator check', { available: availability.available, error: availability.error });
    if (!availability.available) {
      pushAssistantMessage('I need an orchestrator to be installed and configured.\n\n**How to fix:**\n1. Install a CLI (Claude Code, Copilot CLI, or Codex CLI)\n2. Open **Settings** > **Orchestrators**\n\n_' + (availability.error || 'None configured') + '_');
      setStatus('error', availability.error || 'No orchestrator'); return;
    }

    const suffix = globalThis.crypto.randomUUID().slice(0, 8);
    const agentId = `assistant_${Date.now()}_${suffix}`;
    state.agentId = agentId;
    const systemPrompt = buildAssistantInstructions();

    log('spawning', { agentId, mode: state.mode, orchestrator: state.orchestrator || 'default' });

    // Use dedicated assistant spawn IPC — handles MCP binding, workspace, execution mode
    await window.clubhouse.assistant.spawn({
      agentId, mission: firstMessage, systemPrompt,
      executionMode: state.mode,
      orchestrator: state.orchestrator || undefined,
    });

    log('spawn succeeded', { agentId });

    // Mode-specific listeners
    if (state.mode === 'interactive') {
      cleanupListeners.push(window.clubhouse.pty.onData(handlePtyData), window.clubhouse.pty.onExit(handlePtyExit));
      ptyAccumulator = '';
    } else if (state.mode === 'structured') {
      cleanupListeners.push(window.clubhouse.agent.onStructuredEvent(handleStructuredEvent));
    } else {
      cleanupListeners.push(window.clubhouse.pty.onExit(handlePtyExit));
      pushAssistantMessage('_Processing..._');
    }
    setStatus('responding');
    while (messageQueue.length > 0) {
      const q = messageQueue.shift()!;
      if (state.mode === 'structured') await window.clubhouse.agent.sendStructuredMessage(agentId, q);
      else if (state.mode === 'interactive') window.clubhouse.pty.write(agentId, q + '\n');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('spawn failed', { error: msg, mode: state.mode });
    pushAssistantMessage(`Failed to start in **${state.mode}** mode.\n\n**Error:** ${msg}\n\nTry switching modes or click reset.`);
    setStatus('error', msg); messageQueue = [];
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getStatus(): AssistantStatus { return state.status; }
export function getError(): string | null { return state.error; }
export function getMode(): AssistantMode { return state.mode; }
export function getOrchestrator(): string | null { return state.orchestrator; }
export function getFeedItems(): FeedItem[] { return [...pendingItems]; }

export function setMode(mode: AssistantMode): void {
  if (mode === state.mode) return;
  log('mode change', { from: state.mode, to: mode });
  reset(); state.mode = mode;
  for (const l of modeListeners) l(mode);
}

export function setOrchestrator(id: string | null): void {
  if (id === state.orchestrator) return;
  log('orchestrator change', { from: state.orchestrator, to: id });
  reset(); state.orchestrator = id;
  for (const l of orchestratorListeners) l(id);
}

export function onFeedUpdate(l: Listener): () => void { feedListeners.add(l); return () => feedListeners.delete(l); }
export function onStatusChange(l: StatusListener): () => void { statusListeners.add(l); return () => statusListeners.delete(l); }
export function onModeChange(l: ModeListener): () => void { modeListeners.add(l); return () => modeListeners.delete(l); }
export function onOrchestratorChange(l: OrchestratorListener): () => void { orchestratorListeners.add(l); return () => orchestratorListeners.delete(l); }

export function reset(): void {
  if (state.agentId) { log('killing', { agentId: state.agentId }); window.clubhouse.agent.killAgent(state.agentId, '').catch(() => {}); }
  cleanupAll();
  const { mode, orchestrator } = state;
  state = { status: 'idle', mode, orchestrator, agentId: null, error: null, pendingText: '' };
  pendingItems.length = 0; messageQueue = []; ptyAccumulator = ''; nextMsgId = 1;
  notifyFeedListeners(); setStatus('idle');
}
