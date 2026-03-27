import { buildAssistantInstructions } from './system-prompt';
import type { FeedItem } from './types';

// ── Types ──────────────────────────────────────────────────────────────────

export type AssistantStatus = 'idle' | 'starting' | 'active' | 'responding' | 'error';

interface AssistantState {
  status: AssistantStatus;
  agentId: string | null;
  error: string | null;
  /** Accumulated text for the current streaming response */
  pendingText: string;
}

type Listener = (items: FeedItem[]) => void;
type StatusListener = (status: AssistantStatus, error: string | null) => void;

// ── Singleton State ────────────────────────────────────────────────────────

let state: AssistantState = {
  status: 'idle',
  agentId: null,
  error: null,
  pendingText: '',
};

let nextMsgId = 1;
const feedListeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
const pendingItems: FeedItem[] = [];
let cleanupEventListener: (() => void) | null = null;
/** Messages queued while the agent is starting */
let messageQueue: string[] = [];

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
  return `assistant-msg-${nextMsgId++}`;
}

function setStatus(status: AssistantStatus, error: string | null = null): void {
  state.status = status;
  state.error = error;
  for (const listener of statusListeners) {
    listener(status, error);
  }
}

function pushItem(item: FeedItem): void {
  pendingItems.push(item);
  notifyFeedListeners();
}

function notifyFeedListeners(): void {
  const snapshot = [...pendingItems];
  for (const listener of feedListeners) {
    listener(snapshot);
  }
}

function pushAssistantMessage(text: string): void {
  pushItem({
    type: 'message',
    message: {
      id: generateId(),
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
    },
  });
}

// ── Structured Event Handler ───────────────────────────────────────────────

function handleStructuredEvent(agentId: string, event: { type: string; timestamp: number; data: any }): void {
  if (agentId !== state.agentId) return;

  switch (event.type) {
    case 'text_delta': {
      state.pendingText += event.data.text;
      // Update the last item if it's a streaming assistant message, else create one
      const lastItem = pendingItems[pendingItems.length - 1];
      if (lastItem?.type === 'message' && lastItem.message?.role === 'assistant' && lastItem.message.id.startsWith('streaming-')) {
        lastItem.message.content = state.pendingText;
        notifyFeedListeners();
      } else {
        pendingItems.push({
          type: 'message',
          message: {
            id: 'streaming-' + generateId(),
            role: 'assistant',
            content: state.pendingText,
            timestamp: Date.now(),
          },
        });
        notifyFeedListeners();
      }
      break;
    }

    case 'text_done': {
      // Finalize the streaming message with the complete text
      const lastItem = pendingItems[pendingItems.length - 1];
      if (lastItem?.type === 'message' && lastItem.message?.role === 'assistant' && lastItem.message.id.startsWith('streaming-')) {
        lastItem.message.content = event.data.text;
        lastItem.message.id = generateId(); // Remove streaming- prefix
        notifyFeedListeners();
      }
      state.pendingText = '';
      setStatus('active');
      break;
    }

    case 'tool_start': {
      pushItem({
        type: 'action',
        action: {
          id: event.data.id,
          toolName: event.data.displayVerb || event.data.name,
          description: getPrimaryInput(event.data.input),
          status: 'running',
          input: event.data.input,
        },
      });
      break;
    }

    case 'tool_end': {
      // Find and update the matching action card
      const actionItem = pendingItems.find(
        (item) => item.type === 'action' && item.action?.id === event.data.id,
      );
      if (actionItem?.action) {
        actionItem.action.status = event.data.status === 'error' ? 'error' : 'completed';
        actionItem.action.output = event.data.result;
        actionItem.action.durationMs = event.data.durationMs;
        if (event.data.status === 'error') {
          actionItem.action.error = event.data.result;
        }
        notifyFeedListeners();
      }
      break;
    }

    case 'error': {
      pushAssistantMessage(`Error: ${event.data.message}`);
      setStatus('error', event.data.message);
      break;
    }

    case 'end': {
      state.pendingText = '';
      if (event.data.reason === 'error') {
        setStatus('error', event.data.summary || 'Agent session ended with error');
      } else {
        setStatus('active');
      }
      break;
    }

    // Ignore: tool_output, file_diff, command_output, permission_request,
    // plan_update, thinking, usage — we don't surface these in the assistant UI
  }
}

function getPrimaryInput(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'command', 'query', 'pattern', 'url', 'path']) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  return '';
}

// ── Core API ───────────────────────────────────────────────────────────────

/**
 * Send a message to the assistant agent.
 * On first call, spawns the agent and starts a structured session.
 * Subsequent calls send follow-up messages.
 */
export async function sendMessage(text: string): Promise<void> {
  // Add user message to feed immediately
  pushItem({
    type: 'message',
    message: {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    },
  });

  if (state.status === 'starting') {
    // Queue message while agent is starting
    messageQueue.push(text);
    return;
  }

  if (state.status === 'idle' || state.status === 'error') {
    // First message — spawn the agent
    await startAgent(text);
    return;
  }

  if (state.status === 'active' && state.agentId) {
    // Send follow-up message
    setStatus('responding');
    try {
      await window.clubhouse.agent.sendStructuredMessage(state.agentId, text);
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
    // Check orchestrator availability
    const availability = await window.clubhouse.agent.checkOrchestrator();
    if (!availability.available) {
      const errorMsg = availability.error || 'No orchestrator configured';
      pushAssistantMessage(
        'I need an orchestrator to be installed and configured before I can help.\n\n' +
        '**How to fix this:**\n' +
        '1. Install an orchestrator CLI (Claude Code, GitHub Copilot CLI, or Codex CLI)\n' +
        '2. Open **Settings** (gear icon below) > **Orchestrators**\n' +
        '3. The orchestrator should be auto-detected once installed\n\n' +
        `_${errorMsg}_`,
      );
      setStatus('error', errorMsg);
      return;
    }

    // Generate agent ID
    const suffix = globalThis.crypto.randomUUID().slice(0, 8);
    const agentId = `assistant_${Date.now()}_${suffix}`;
    state.agentId = agentId;

    // Use home directory as the working directory (assistant has no project)
    const homeDir = getHomeDir();
    const systemPrompt = buildAssistantInstructions();

    // Spawn the agent process
    await window.clubhouse.agent.spawnAgent({
      agentId,
      projectPath: homeDir,
      cwd: homeDir,
      kind: 'quick',
      systemPrompt,
      mission: firstMessage,
      freeAgentMode: true, // No tool restrictions for the assistant
    });

    // Listen for structured events
    cleanupEventListener = window.clubhouse.agent.onStructuredEvent(handleStructuredEvent);

    // Start structured session
    await window.clubhouse.agent.startStructured(agentId, {
      mission: firstMessage,
      systemPrompt,
      cwd: homeDir,
      freeAgentMode: true,
    });

    setStatus('responding');

    // Drain any queued messages (sent while agent was starting)
    while (messageQueue.length > 0) {
      const queued = messageQueue.shift()!;
      await window.clubhouse.agent.sendStructuredMessage(agentId, queued);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isStructuredError = msg.includes('structured') || msg.includes('does not support');
    if (isStructuredError) {
      pushAssistantMessage(
        'The assistant could not start a structured session with your orchestrator.\n\n' +
        'This may mean the orchestrator CLI needs to be updated, or structured mode ' +
        'is not fully supported yet.\n\n' +
        '**Try:** Update your orchestrator CLI to the latest version and try again.\n\n' +
        `_${msg}_`,
      );
    } else {
      pushAssistantMessage(
        `Something went wrong starting the assistant.\n\n` +
        `**Error:** ${msg}\n\n` +
        'Try clicking the reset button (top right) to start a fresh conversation.',
      );
    }
    setStatus('error', msg);
    messageQueue = [];
  }
}

function getHomeDir(): string {
  try {
    const platform = window.clubhouse.platform;
    if (platform === 'win32') {
      return (typeof process !== 'undefined' && process.env?.USERPROFILE) || 'C:\\Users';
    }
    return (typeof process !== 'undefined' && process.env?.HOME) || '/tmp';
  } catch {
    return '/tmp';
  }
}

/** Get current status */
export function getStatus(): AssistantStatus {
  return state.status;
}

/** Get current error message */
export function getError(): string | null {
  return state.error;
}

/** Get all feed items */
export function getFeedItems(): FeedItem[] {
  return [...pendingItems];
}

/** Subscribe to feed updates */
export function onFeedUpdate(listener: Listener): () => void {
  feedListeners.add(listener);
  return () => feedListeners.delete(listener);
}

/** Subscribe to status changes */
export function onStatusChange(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** Reset the assistant — kills agent, clears state */
export function reset(): void {
  if (state.agentId) {
    const homeDir = getHomeDir();
    window.clubhouse.agent.killAgent(state.agentId, homeDir).catch(() => {});
  }
  if (cleanupEventListener) {
    cleanupEventListener();
    cleanupEventListener = null;
  }
  state = {
    status: 'idle',
    agentId: null,
    error: null,
    pendingText: '',
  };
  pendingItems.length = 0;
  messageQueue = [];
  nextMsgId = 1;
  notifyFeedListeners();
  setStatus('idle');
}
