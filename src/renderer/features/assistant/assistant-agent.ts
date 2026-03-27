import { buildAssistantInstructions } from './system-prompt';
import type { FeedItem } from './types';

// ── Types ──────────────────────────────────────────────────────────────────

export type AssistantStatus = 'idle' | 'starting' | 'active' | 'responding' | 'error';
export type AssistantMode = 'interactive' | 'structured' | 'headless';

interface AssistantState {
  status: AssistantStatus;
  mode: AssistantMode;
  agentId: string | null;
  error: string | null;
  pendingText: string;
}

type Listener = (items: FeedItem[]) => void;
type StatusListener = (status: AssistantStatus, error: string | null) => void;
type ModeListener = (mode: AssistantMode) => void;

// ── Singleton State ────────────────────────────────────────────────────────

let state: AssistantState = {
  status: 'idle',
  mode: 'interactive',
  agentId: null,
  error: null,
  pendingText: '',
};

let nextMsgId = 1;
const feedListeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
const modeListeners = new Set<ModeListener>();
const pendingItems: FeedItem[] = [];
let cleanupListeners: Array<() => void> = [];
let messageQueue: string[] = [];
/** Accumulator for PTY output between user messages */
let ptyAccumulator = '';
/** Timer for detecting PTY idle (agent done responding) */
let ptyIdleTimer: ReturnType<typeof setTimeout> | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
  return `assistant-msg-${nextMsgId++}`;
}

function setStatus(status: AssistantStatus, error: string | null = null): void {
  state.status = status;
  state.error = error;
  for (const listener of statusListeners) listener(status, error);
}

function pushItem(item: FeedItem): void {
  pendingItems.push(item);
  notifyFeedListeners();
}

function notifyFeedListeners(): void {
  const snapshot = [...pendingItems];
  for (const listener of feedListeners) listener(snapshot);
}

function pushAssistantMessage(text: string): void {
  pushItem({
    type: 'message',
    message: { id: generateId(), role: 'assistant', content: text, timestamp: Date.now() },
  });
}

function cleanupAll(): void {
  for (const fn of cleanupListeners) fn();
  cleanupListeners = [];
  if (ptyIdleTimer) { clearTimeout(ptyIdleTimer); ptyIdleTimer = null; }
}

function getHomeDir(): string {
  try {
    const platform = window.clubhouse.platform;
    if (platform === 'win32') {
      return (typeof process !== 'undefined' && process.env?.USERPROFILE) || 'C:\\Users';
    }
    return (typeof process !== 'undefined' && process.env?.HOME) || '/tmp';
  } catch { return '/tmp'; }
}

// ── ANSI Stripping ─────────────────────────────────────────────────────────

/** Strip ANSI escape sequences from terminal output. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// ── Structured Event Handler ───────────────────────────────────────────────

function handleStructuredEvent(_agentId: string, event: { type: string; timestamp: number; data: any }): void {
  if (_agentId !== state.agentId) return;

  switch (event.type) {
    case 'text_delta': {
      state.pendingText += event.data.text;
      const lastItem = pendingItems[pendingItems.length - 1];
      if (lastItem?.type === 'message' && lastItem.message?.role === 'assistant' && lastItem.message.id.startsWith('streaming-')) {
        lastItem.message.content = state.pendingText;
        notifyFeedListeners();
      } else {
        pendingItems.push({
          type: 'message',
          message: { id: 'streaming-' + generateId(), role: 'assistant', content: state.pendingText, timestamp: Date.now() },
        });
        notifyFeedListeners();
      }
      break;
    }
    case 'text_done': {
      const lastItem = pendingItems[pendingItems.length - 1];
      if (lastItem?.type === 'message' && lastItem.message?.role === 'assistant' && lastItem.message.id.startsWith('streaming-')) {
        lastItem.message.content = event.data.text;
        lastItem.message.id = generateId();
        notifyFeedListeners();
      }
      state.pendingText = '';
      setStatus('active');
      break;
    }
    case 'tool_start':
      pushItem({ type: 'action', action: { id: event.data.id, toolName: event.data.displayVerb || event.data.name, description: getPrimaryInput(event.data.input), status: 'running', input: event.data.input } });
      break;
    case 'tool_end': {
      const actionItem = pendingItems.find(i => i.type === 'action' && i.action?.id === event.data.id);
      if (actionItem?.action) {
        actionItem.action.status = event.data.status === 'error' ? 'error' : 'completed';
        actionItem.action.output = event.data.result;
        actionItem.action.durationMs = event.data.durationMs;
        if (event.data.status === 'error') actionItem.action.error = event.data.result;
        notifyFeedListeners();
      }
      break;
    }
    case 'error':
      pushAssistantMessage(`Error: ${event.data.message}`);
      setStatus('error', event.data.message);
      break;
    case 'end':
      state.pendingText = '';
      setStatus(event.data.reason === 'error' ? 'error' : 'active', event.data.reason === 'error' ? (event.data.summary || 'Session ended with error') : null);
      break;
  }
}

function getPrimaryInput(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'command', 'query', 'pattern', 'url', 'path']) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  return '';
}

// ── PTY Output Handler ─────────────────────────────────────────────────────

function handlePtyData(agentId: string, data: string): void {
  if (agentId !== state.agentId) return;

  ptyAccumulator += data;

  // Reset idle timer — we consider the agent "done responding" after 1.5s of silence
  if (ptyIdleTimer) clearTimeout(ptyIdleTimer);
  ptyIdleTimer = setTimeout(() => {
    if (ptyAccumulator.trim()) {
      const cleaned = stripAnsi(ptyAccumulator).trim();
      if (cleaned) {
        // Update existing streaming message or create new one
        const lastItem = pendingItems[pendingItems.length - 1];
        if (lastItem?.type === 'message' && lastItem.message?.role === 'assistant' && lastItem.message.id.startsWith('streaming-')) {
          lastItem.message.content = cleaned;
          lastItem.message.id = generateId();
          notifyFeedListeners();
        } else {
          pushAssistantMessage(cleaned);
        }
      }
      ptyAccumulator = '';
    }
    setStatus('active');
  }, 1500);

  // Show streaming preview
  const cleaned = stripAnsi(ptyAccumulator).trim();
  if (cleaned) {
    const lastItem = pendingItems[pendingItems.length - 1];
    if (lastItem?.type === 'message' && lastItem.message?.role === 'assistant' && lastItem.message.id.startsWith('streaming-')) {
      lastItem.message.content = cleaned;
      notifyFeedListeners();
    } else {
      pendingItems.push({
        type: 'message',
        message: { id: 'streaming-' + generateId(), role: 'assistant', content: cleaned, timestamp: Date.now() },
      });
      notifyFeedListeners();
    }
  }
}

function handlePtyExit(agentId: string, _exitCode: number): void {
  if (agentId !== state.agentId) return;

  // Flush any remaining PTY output
  if (ptyAccumulator.trim()) {
    const cleaned = stripAnsi(ptyAccumulator).trim();
    if (cleaned) pushAssistantMessage(cleaned);
    ptyAccumulator = '';
  }

  if (state.mode === 'headless') {
    // For headless, read the transcript
    readHeadlessResult(agentId);
  } else {
    setStatus('active');
  }
}

// ── Headless Result Reader ─────────────────────────────────────────────────

async function readHeadlessResult(agentId: string): Promise<void> {
  try {
    const transcript = await window.clubhouse.agent.readTranscript(agentId);
    if (transcript) {
      // Parse JSONL transcript to find text content
      const lines = transcript.split('\n').filter((l: string) => l.trim());
      let responseText = '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'text' || event.type === 'text_done') {
            responseText = event.text || event.data?.text || responseText;
          } else if (event.type === 'result') {
            responseText = event.result || responseText;
          }
        } catch { /* skip malformed lines */ }
      }
      if (responseText) {
        pushAssistantMessage(responseText);
      } else {
        pushAssistantMessage('_The agent completed but produced no text response._');
      }
    } else {
      pushAssistantMessage('_No transcript available from the agent._');
    }
  } catch (err) {
    pushAssistantMessage(`_Failed to read agent response: ${err instanceof Error ? err.message : String(err)}_`);
  }
  setStatus('idle'); // Headless agents are one-shot, back to idle
}

// ── Core API ───────────────────────────────────────────────────────────────

export async function sendMessage(text: string): Promise<void> {
  pushItem({
    type: 'message',
    message: { id: generateId(), role: 'user', content: text, timestamp: Date.now() },
  });

  if (state.status === 'starting') {
    messageQueue.push(text);
    return;
  }

  if (state.status === 'idle' || state.status === 'error') {
    await startAgent(text);
    return;
  }

  if (state.status === 'active' && state.agentId) {
    setStatus('responding');
    try {
      if (state.mode === 'structured') {
        await window.clubhouse.agent.sendStructuredMessage(state.agentId, text);
      } else if (state.mode === 'interactive') {
        ptyAccumulator = '';
        window.clubhouse.pty.write(state.agentId, text + '\n');
      } else {
        // Headless: spawn a new agent for each message
        await startAgent(text);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushAssistantMessage(`Failed to send message: ${msg}`);
      setStatus('error', msg);
    }
    return;
  }
}

async function startAgent(firstMessage: string): Promise<void> {
  setStatus('starting');

  try {
    const availability = await window.clubhouse.agent.checkOrchestrator();
    if (!availability.available) {
      pushAssistantMessage(
        'I need an orchestrator to be installed and configured before I can help.\n\n' +
        '**How to fix this:**\n' +
        '1. Install an orchestrator CLI (Claude Code, GitHub Copilot CLI, or Codex CLI)\n' +
        '2. Open **Settings** (gear icon below) > **Orchestrators**\n' +
        '3. The orchestrator should be auto-detected once installed\n\n' +
        `_${availability.error || 'No orchestrator configured'}_`,
      );
      setStatus('error', availability.error || 'No orchestrator configured');
      return;
    }

    const suffix = globalThis.crypto.randomUUID().slice(0, 8);
    const agentId = `assistant_${Date.now()}_${suffix}`;
    state.agentId = agentId;

    const homeDir = getHomeDir();
    const systemPrompt = buildAssistantInstructions();

    if (state.mode === 'interactive') {
      await startInteractive(agentId, homeDir, systemPrompt, firstMessage);
    } else if (state.mode === 'structured') {
      await startStructured(agentId, homeDir, systemPrompt, firstMessage);
    } else {
      await startHeadless(agentId, homeDir, systemPrompt, firstMessage);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushAssistantMessage(
      `Failed to start the assistant in **${state.mode}** mode.\n\n` +
      `**Error:** ${msg}\n\n` +
      'Try switching modes using the toggle in the header, or click reset.',
    );
    setStatus('error', msg);
    messageQueue = [];
  }
}

async function startInteractive(agentId: string, homeDir: string, systemPrompt: string, mission: string): Promise<void> {
  // PTY mode: spawn agent normally (no structuredMode flag), it falls through to PTY
  await window.clubhouse.agent.spawnAgent({
    agentId, projectPath: homeDir, cwd: homeDir, kind: 'quick',
    systemPrompt, mission, freeAgentMode: true,
  });

  // Listen for PTY output
  const unsubData = window.clubhouse.pty.onData(handlePtyData);
  const unsubExit = window.clubhouse.pty.onExit(handlePtyExit);
  cleanupListeners.push(unsubData, unsubExit);

  ptyAccumulator = '';
  setStatus('responding');

  while (messageQueue.length > 0) {
    const queued = messageQueue.shift()!;
    window.clubhouse.pty.write(agentId, queued + '\n');
  }
}

async function startStructured(agentId: string, homeDir: string, systemPrompt: string, mission: string): Promise<void> {
  // Structured mode: set structuredMode flag so spawnAgent starts a structured session internally
  await window.clubhouse.agent.spawnAgent({
    agentId, projectPath: homeDir, cwd: homeDir, kind: 'quick',
    systemPrompt, mission, freeAgentMode: true,
    structuredMode: true,
  });

  // Listen for structured events (the session is already started by spawnAgent)
  const unsub = window.clubhouse.agent.onStructuredEvent(handleStructuredEvent);
  cleanupListeners.push(unsub);

  setStatus('responding');

  while (messageQueue.length > 0) {
    const queued = messageQueue.shift()!;
    await window.clubhouse.agent.sendStructuredMessage(agentId, queued);
  }
}

async function startHeadless(agentId: string, homeDir: string, systemPrompt: string, mission: string): Promise<void> {
  // Headless: spawn agent, it runs mission to completion then exits
  // We listen for PTY.EXIT to know when it's done, then read transcript
  await window.clubhouse.agent.spawnAgent({
    agentId, projectPath: homeDir, cwd: homeDir, kind: 'quick',
    systemPrompt, mission, freeAgentMode: true,
  });

  const unsubExit = window.clubhouse.pty.onExit(handlePtyExit);
  cleanupListeners.push(unsubExit);

  pushAssistantMessage('_Processing your request..._');
  setStatus('responding');
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getStatus(): AssistantStatus { return state.status; }
export function getError(): string | null { return state.error; }
export function getMode(): AssistantMode { return state.mode; }
export function getFeedItems(): FeedItem[] { return [...pendingItems]; }

export function setMode(mode: AssistantMode): void {
  if (mode === state.mode) return;
  reset();
  state.mode = mode;
  for (const listener of modeListeners) listener(mode);
}

export function onFeedUpdate(listener: Listener): () => void {
  feedListeners.add(listener);
  return () => feedListeners.delete(listener);
}

export function onStatusChange(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function onModeChange(listener: ModeListener): () => void {
  modeListeners.add(listener);
  return () => modeListeners.delete(listener);
}

export function reset(): void {
  if (state.agentId) {
    const homeDir = getHomeDir();
    window.clubhouse.agent.killAgent(state.agentId, homeDir).catch(() => {});
  }
  cleanupAll();
  const currentMode = state.mode;
  state = { status: 'idle', mode: currentMode, agentId: null, error: null, pendingText: '' };
  pendingItems.length = 0;
  messageQueue = [];
  ptyAccumulator = '';
  nextMsgId = 1;
  notifyFeedListeners();
  setStatus('idle');
}
