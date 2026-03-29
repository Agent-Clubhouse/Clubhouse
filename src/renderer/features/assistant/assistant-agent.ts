import { buildAssistantInstructions } from './system-prompt';
import type { FeedItem } from './types';

// ── Types ──────────────────────────────────────────────────────────────────

export type AssistantStatus = 'idle' | 'starting' | 'active' | 'responding' | 'error';

/**
 * Tri-state execution modes:
 * - interactive: Raw PTY terminal (same as durable agents). No chat UI.
 * - headless:    Conversational chat via headless with session persistence.
 *                Follow-ups use --continue to resume the session.
 * - structured:  Experimental chat via structured mode with typed events.
 */
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
type AgentIdListener = (agentId: string | null) => void;

// ── Singleton State ────────────────────────────────────────────────────────

let state: AssistantState = {
  status: 'idle',
  mode: 'interactive',
  orchestrator: null,
  agentId: null,
  error: null,
  pendingText: '',
};

let nextMsgId = 1;
const feedListeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
const modeListeners = new Set<ModeListener>();
const orchestratorListeners = new Set<OrchestratorListener>();
const agentIdListeners = new Set<AgentIdListener>();
const pendingItems: FeedItem[] = [];
let cleanupListeners: Array<() => void> = [];
let messageQueue: string[] = [];

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
  return `assistant-msg-${nextMsgId++}`;
}

function setStatus(status: AssistantStatus, error: string | null = null): void {
  state.status = status;
  state.error = error;
  for (const listener of statusListeners) listener(status, error);
}

function setAgentId(agentId: string | null): void {
  state.agentId = agentId;
  for (const listener of agentIdListeners) listener(agentId);
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

/**
 * Remove the last "Processing..." placeholder message from the feed.
 * Called before pushing the real response or an error message.
 */
function removePendingPlaceholder(): void {
  for (let i = pendingItems.length - 1; i >= 0; i--) {
    const item = pendingItems[i];
    if (
      item.type === 'message' &&
      item.message?.role === 'assistant' &&
      (item.message.content === '_Processing your request..._' ||
       item.message.content === '_Processing your follow-up..._')
    ) {
      pendingItems.splice(i, 1);
      notifyFeedListeners();
      break;
    }
  }
}

function cleanupAll(): void {
  for (const fn of cleanupListeners) fn();
  cleanupListeners = [];
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
      setStatus('responding');
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
    case 'tool_start': {
      const toolName = event.data.displayVerb || event.data.name;
      const groupId = event.data.groupId || undefined;
      const needsApproval = isMutatingTool(event.data.name);
      pushItem({
        type: 'action',
        action: {
          id: event.data.id,
          toolName,
          description: getPrimaryInput(event.data.input),
          status: needsApproval ? 'pending_approval' : 'running',
          input: event.data.input,
          groupId,
        },
      });
      setStatus('responding');
      break;
    }
    case 'tool_output': {
      // Streaming tool output — update the matching action card's output
      const outputItem = pendingItems.find(i => i.type === 'action' && i.action?.id === event.data.id);
      if (outputItem?.action) {
        outputItem.action.output = (outputItem.action.output || '') + event.data.output;
        notifyFeedListeners();
      }
      break;
    }
    case 'tool_end': {
      const actionItem = pendingItems.find(i => i.type === 'action' && i.action?.id === event.data.id);
      if (actionItem?.action) {
        actionItem.action.status = event.data.status === 'error' ? 'error' : 'completed';
        actionItem.action.output = event.data.result;
        actionItem.action.durationMs = event.data.durationMs;
        actionItem.action.resultSummary = event.data.resultSummary;
        if (event.data.status === 'error') actionItem.action.error = event.data.result;
        notifyFeedListeners();
      }
      break;
    }
    case 'file_diff':
      pushItem({ type: 'action', action: { id: generateId(), toolName: `${event.data.changeType} file`, description: event.data.path, status: 'completed', output: event.data.diff } });
      break;
    case 'command_output':
      pushItem({ type: 'action', action: { id: event.data.id, toolName: 'shell', description: event.data.command, status: event.data.status === 'failed' ? 'error' : event.data.status === 'completed' ? 'completed' : 'running', output: event.data.output } });
      break;
    case 'permission_request':
      pushItem({ type: 'action', action: { id: event.data.id, toolName: event.data.toolName, description: event.data.description, status: 'pending', input: event.data.toolInput } });
      break;
    case 'thinking':
      // Thinking tokens are informational — don't surface in the chat feed
      break;
    case 'plan_update':
      // Plan updates could be surfaced later; skip for now
      break;
    case 'usage':
      // Token usage is informational — tracked but not surfaced in chat
      break;
    case 'error': {
      // Only surface non-stderr errors as visible errors in the chat
      const code = event.data.code;
      if (code === 'stderr') break; // CLI diagnostic output, not a real error
      pushAssistantMessage(`Error: ${event.data.message}`);
      setStatus('error', event.data.message);
      break;
    }
    case 'end':
      state.pendingText = '';
      if (event.data.reason === 'error') {
        setStatus('error', event.data.summary || 'Session ended with error');
      } else {
        persistHistory();
        setStatus('active');
      }
      break;
  }
}

/** Tools that modify state and should require user approval before execution. */
const MUTATING_TOOLS = new Set([
  'create_project', 'create_canvas', 'create_agent',
  'add_card', 'add_zone', 'add_wire', 'update_card',
  'delete_project', 'delete_canvas', 'delete_agent',
  'write_file', 'run_command',
  'update_project', 'update_agent', 'update_canvas',
]);

function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

function getPrimaryInput(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'command', 'query', 'pattern', 'url', 'path']) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  return '';
}

// ── Headless Result Handler ───────────────────────────────────────────────

function handleHeadlessResult(result: { agentId: string; exitCode: number }): void {
  // Match against our tracked agent or a follow-up agent
  if (result.agentId !== state.agentId && !result.agentId.startsWith('assistant_followup_')) return;

  // Surface non-zero exit codes as errors
  if (result.exitCode !== 0) {
    removePendingPlaceholder();
    pushAssistantMessage(`_The assistant exited with an error (code ${result.exitCode}). Try sending your message again or reset the assistant._`);
    setStatus('active');
    return;
  }

  readHeadlessResult(result.agentId);
}

// ── PTY Exit Handler (for interactive mode) ───────────────────────────────

function handlePtyExit(agentId: string, _exitCode: number): void {
  if (agentId !== state.agentId) return;

  // Interactive mode: terminal closed, back to idle
  setAgentId(null);
  setStatus('idle');
}

// ── Headless Result Reader ─────────────────────────────────────────────────

async function readHeadlessResult(agentId: string): Promise<void> {
  // Remove the "Processing..." placeholder before showing the real response
  removePendingPlaceholder();

  try {
    const transcript = await window.clubhouse.agent.readTranscript(agentId);
    if (transcript) {
      const lines = transcript.split('\n').filter((l: string) => l.trim());
      let responseText = '';
      const errors: string[] = [];
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'text' || event.type === 'text_done') {
            responseText = event.text || event.data?.text || responseText;
          } else if (event.type === 'result') {
            responseText = event.result || responseText;
          } else if (event.type === 'error') {
            errors.push(event.error || event.message || 'Unknown error');
          }
        } catch {
          // Skip malformed JSONL lines — not an error condition
        }
      }
      if (responseText) {
        pushAssistantMessage(responseText);
      } else if (errors.length > 0) {
        pushAssistantMessage(`**Error from assistant:**\n${errors.join('\n')}`);
      } else {
        pushAssistantMessage('_The agent completed but produced no text response. Try rephrasing your question._');
      }
    } else {
      pushAssistantMessage('_No transcript available from the agent. The orchestrator may have failed to start._');
    }
  } catch (err) {
    pushAssistantMessage(`_Failed to read agent response: ${err instanceof Error ? err.message : String(err)}_`);
  }

  // Persist updated history after receiving response
  persistHistory();

  // Conversational: stay active for follow-ups
  setStatus('active');
}

// ── Core API ───────────────────────────────────────────────────────────────

export async function sendMessage(text: string): Promise<void> {
  // In interactive mode, messages are only used to start the agent.
  // Once running, the user types directly in the terminal.
  if (state.mode === 'interactive' && (state.status === 'active' || state.status === 'responding')) {
    return;
  }

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
        try {
          await window.clubhouse.agent.sendStructuredMessage(state.agentId, text);
        } catch {
          // Adapter doesn't support multi-turn (e.g. StreamJsonAdapter in single-turn mode).
          // Use structured follow-up path with --continue to preserve conversation context.
          await structuredFollowup(text);
        }
      } else if (state.mode === 'headless') {
        // Conversational follow-up via headless --continue
        pushAssistantMessage('_Processing your follow-up..._');
        // Persist user message immediately so history survives crashes
        persistHistory();
        const result = await window.clubhouse.assistant.sendFollowup({
          message: text,
          orchestrator: state.orchestrator || undefined,
        });
        if (result?.agentId) {
          setAgentId(result.agentId);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      removePendingPlaceholder();
      pushAssistantMessage(`**Failed to send message:** ${msg}\n\nTry again or reset the assistant.`);
      setStatus('error', msg);
    }
    return;
  }
}

async function startAgent(firstMessage: string): Promise<void> {
  setStatus('starting');

  try {
    const availability = await window.clubhouse.agent.checkOrchestrator(undefined, state.orchestrator || undefined);
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
    setAgentId(agentId);

    // For structured mode, register the event listener BEFORE spawning
    // so we don't miss any early events from the adapter.
    if (state.mode === 'structured') {
      setupStructuredListener(agentId);
    }

    const systemPrompt = buildAssistantInstructions();

    // Use dedicated assistant spawn IPC — handles MCP binding, workspace, execution mode
    await window.clubhouse.assistant.spawn({
      agentId,
      mission: firstMessage,
      systemPrompt,
      executionMode: state.mode,
      orchestrator: state.orchestrator || undefined,
    });

    if (state.mode === 'interactive') {
      await setupInteractive();
    } else if (state.mode === 'structured') {
      // Listener already registered above — just set status and drain queue
      setStatus('responding');
      while (messageQueue.length > 0) {
        const queued = messageQueue.shift()!;
        await window.clubhouse.agent.sendStructuredMessage(agentId, queued);
      }
    } else {
      setupHeadless();
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

async function setupInteractive(): Promise<void> {
  // Listen for PTY exit only — AgentTerminal component handles all rendering
  const unsubExit = window.clubhouse.pty.onExit(handlePtyExit);
  cleanupListeners.push(unsubExit);

  setStatus('active');
}

/**
 * Register the structured event listener for the given agent.
 * Must be called BEFORE spawning so no early events are missed.
 */
function setupStructuredListener(_agentId: string): void {
  // Remove any previous structured listener to prevent accumulation
  // across follow-up sessions (each follow-up calls startAgent again).
  cleanupAll();

  const unsub = window.clubhouse.agent.onStructuredEvent(handleStructuredEvent);
  cleanupListeners.push(unsub);
}

function setupHeadless(): void {
  // Listen for headless result events from main process
  const unsubResult = window.clubhouse.assistant.onResult(handleHeadlessResult);
  cleanupListeners.push(unsubResult);

  pushAssistantMessage('_Processing your request..._');
  // Persist user's first message before we start waiting for response
  persistHistory();
  setStatus('responding');
}

/**
 * Send a follow-up message in structured mode.
 * Spawns a new structured session with --continue to preserve conversation context.
 * The new session resumes from the previous session in the same workspace.
 */
async function structuredFollowup(message: string): Promise<void> {
  const newAgentId = `assistant_followup_${Date.now()}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  setAgentId(newAgentId);

  // Re-register listener for the new agentId (before spawn to avoid race)
  setupStructuredListener(newAgentId);

  setStatus('responding');

  try {
    const result = await window.clubhouse.assistant.sendStructuredFollowup({
      message,
      orchestrator: state.orchestrator || undefined,
    });
    if (result?.agentId) {
      setAgentId(result.agentId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    removePendingPlaceholder();
    pushAssistantMessage(`**Failed to send follow-up:** ${msg}\n\nTry again or reset the assistant.`);
    setStatus('error', msg);
  }
}

// ── History Persistence ───────────────────────────────────────────────────

/** Debounce timer for history persistence to avoid excessive disk writes. */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Persist current feed items to disk (debounced).
 * Called after receiving responses and sending messages.
 */
function persistHistory(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const items = pendingItems.filter(
      (item) =>
        // Only persist real messages, not placeholders
        !(item.type === 'message' &&
          item.message?.role === 'assistant' &&
          (item.message.content === '_Processing your request..._' ||
           item.message.content === '_Processing your follow-up..._')),
    );
    window.clubhouse.assistant.saveHistory(items).catch(() => {});
  }, 500);
}

/**
 * Load previously saved chat history from disk.
 * Called on assistant initialization to restore conversations.
 */
export async function loadHistory(): Promise<void> {
  try {
    const items = await window.clubhouse.assistant.loadHistory();
    if (items && Array.isArray(items) && items.length > 0) {
      pendingItems.length = 0;
      for (const item of items) {
        pendingItems.push(item);
      }
      notifyFeedListeners();
    }
  } catch {
    // Silently ignore — fresh start if history can't be loaded
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getStatus(): AssistantStatus { return state.status; }
export function getError(): string | null { return state.error; }
export function getMode(): AssistantMode { return state.mode; }
export function getOrchestrator(): string | null { return state.orchestrator; }
export function getAgentId(): string | null { return state.agentId; }
export function getFeedItems(): FeedItem[] { return [...pendingItems]; }

export function setMode(mode: AssistantMode): void {
  if (mode === state.mode) return;
  reset();
  state.mode = mode;
  for (const listener of modeListeners) listener(mode);
}

export function setOrchestrator(id: string | null): void {
  if (id === state.orchestrator) return;
  reset();
  state.orchestrator = id;
  for (const listener of orchestratorListeners) listener(id);
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

export function onOrchestratorChange(listener: OrchestratorListener): () => void {
  orchestratorListeners.add(listener);
  return () => orchestratorListeners.delete(listener);
}

export function onAgentIdChange(listener: AgentIdListener): () => void {
  agentIdListeners.add(listener);
  return () => agentIdListeners.delete(listener);
}

export function approveAction(actionId: string): void {
  const item = pendingItems.find(i => i.type === 'action' && i.action?.id === actionId);
  if (item?.action && item.action.status === 'pending_approval') {
    item.action.status = 'running';
    notifyFeedListeners();
    // Notify the orchestrator that the tool execution is approved
    // The IPC method may not exist yet — guarded by optional chaining on the untyped cast
    if (state.agentId && state.mode === 'structured') {
      (window.clubhouse.agent as any).approveToolExecution?.(state.agentId, actionId)?.catch?.(() => {});
    }
  }
}

export function skipAction(actionId: string): void {
  const item = pendingItems.find(i => i.type === 'action' && i.action?.id === actionId);
  if (item?.action && item.action.status === 'pending_approval') {
    item.action.status = 'skipped';
    notifyFeedListeners();
    // Notify the orchestrator to skip this tool execution
    // The IPC method may not exist yet — guarded by optional chaining on the untyped cast
    if (state.agentId && state.mode === 'structured') {
      (window.clubhouse.agent as any).skipToolExecution?.(state.agentId, actionId)?.catch?.(() => {});
    }
  }
}

export function reset(): void {
  if (state.agentId) {
    // Kill the running agent process
    window.clubhouse.agent.killAgent(state.agentId, '').catch(() => {});
    // Clean up MCP bindings and agent registry in main process
    window.clubhouse.assistant.reset(state.agentId).catch(() => {});
  }
  cleanupAll();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const { mode, orchestrator } = state;
  state = { status: 'idle', mode, orchestrator, agentId: null, error: null, pendingText: '' };
  pendingItems.length = 0;
  messageQueue = [];
  nextMsgId = 1;
  notifyFeedListeners();
  setAgentId(null);
  setStatus('idle');
  // Clear persisted history on explicit reset
  window.clubhouse.assistant.saveHistory([]).catch(() => {});
}
