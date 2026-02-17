import type { PluginAPI, Disposable, CompletedQuickAgentInfo } from '../../../../shared/plugin-types';
import type { Card, Board, AutomationRun, BoardState } from './types';
import { BOARDS_KEY, cardsKey, AUTOMATION_RUNS_KEY } from './types';
import { kanBossState } from './state';

// ── Module-level engine state ───────────────────────────────────────────

let engineApi: PluginAPI | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────

async function loadBoard(api: PluginAPI, boardId: string): Promise<Board | null> {
  const raw = await api.storage.projectLocal.read(BOARDS_KEY);
  const boards: Board[] = Array.isArray(raw) ? raw : [];
  return boards.find((b) => b.id === boardId) ?? null;
}

function cardsStor(api: PluginAPI, board: Board) {
  return board.config.gitHistory ? api.storage.project : api.storage.projectLocal;
}

async function loadCards(api: PluginAPI, board: Board): Promise<Card[]> {
  const raw = await cardsStor(api, board).read(cardsKey(board.id));
  return Array.isArray(raw) ? raw : [];
}

async function saveCards(api: PluginAPI, board: Board, cards: Card[]): Promise<void> {
  await cardsStor(api, board).write(cardsKey(board.id), cards);
}

async function loadRuns(api: PluginAPI): Promise<AutomationRun[]> {
  const raw = await api.storage.projectLocal.read(AUTOMATION_RUNS_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function saveRuns(api: PluginAPI, runs: AutomationRun[]): Promise<void> {
  await api.storage.projectLocal.write(AUTOMATION_RUNS_KEY, runs);
}

function addHistory(card: Card, action: Card['history'][0]['action'], detail: string, agentId?: string): void {
  card.history.push({ action, timestamp: Date.now(), detail, agentId });
  card.updatedAt = Date.now();
}

// ── Trigger automation for a card ───────────────────────────────────────

export async function triggerAutomation(api: PluginAPI, card: Card, board: Board): Promise<void> {
  const state = board.states.find((s) => s.id === card.stateId);
  if (!state || !state.isAutomatic) return;

  const swimlane = board.swimlanes.find((l) => l.id === card.swimlaneId);
  if (!swimlane || !swimlane.managerAgentId) return;

  if (card.automationAttempts >= board.config.maxRetries) {
    // Already stuck — don't retry
    return;
  }

  const prompt = [
    'You are working on a Kanban card task. Complete the following outcome:',
    '',
    `OUTCOME: ${state.automationPrompt}`,
    '',
    `CARD TITLE: ${card.title}`,
    `CARD DESCRIPTION: ${card.body}`,
    '',
    'Complete the work needed to satisfy the outcome above. Focus only on completing the task.',
    'When done, provide a summary of what you accomplished.',
  ].join('\n');

  try {
    const executionAgentId = await api.agents.runQuick(prompt);

    // Record run — track the configured evaluation agent for this swimlane
    const configuredEvalAgent = swimlane.evaluationAgentId ?? swimlane.managerAgentId;
    const runs = await loadRuns(api);
    runs.push({
      cardId: card.id,
      boardId: board.id,
      stateId: card.stateId,
      swimlaneId: card.swimlaneId,
      executionAgentId,
      evaluationAgentId: null,
      configuredEvaluationAgentId: configuredEvalAgent,
      phase: 'executing',
      attempt: card.automationAttempts + 1,
      startedAt: Date.now(),
    });
    await saveRuns(api, runs);

    // Update card
    const cards = await loadCards(api, board);
    const idx = cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      cards[idx].automationAttempts++;
      addHistory(cards[idx], 'automation-started',
        `Automation attempt ${cards[idx].automationAttempts} started`, executionAgentId);
      await saveCards(api, board, cards);
    }

    kanBossState.triggerRefresh();
  } catch {
    // Agent spawn failed
    api.logging.warn('KanBoss: Failed to spawn execution agent', { cardId: card.id });
  }
}

// ── Handle agent completion ─────────────────────────────────────────────

async function onAgentCompleted(api: PluginAPI, agentId: string, outcome: 'success' | 'error'): Promise<void> {
  const runs = await loadRuns(api);
  const runIdx = runs.findIndex((r) =>
    (r.executionAgentId === agentId && r.phase === 'executing') ||
    (r.evaluationAgentId === agentId && r.phase === 'evaluating')
  );
  if (runIdx === -1) return;

  const run = runs[runIdx];
  const board = await loadBoard(api, run.boardId);
  if (!board) return;

  const cards = await loadCards(api, board);
  const cardIdx = cards.findIndex((c) => c.id === run.cardId);
  if (cardIdx === -1) return;

  const card = cards[cardIdx];

  if (run.phase === 'executing') {
    if (outcome === 'error') {
      addHistory(card, 'automation-failed', 'Execution agent errored', agentId);
      checkStuck(card, board);
      runs.splice(runIdx, 1);
      await saveRuns(api, runs);
      await saveCards(api, board, cards);
      kanBossState.triggerRefresh();
      return;
    }

    // Execution succeeded — spawn evaluation agent
    const completed = api.agents.listCompleted();
    const info = completed.find((c) => c.id === agentId);

    const state = board.states.find((s) => s.id === run.stateId);
    if (!state) return;

    const evalPrompt = [
      'Evaluate whether this outcome has been met:',
      '',
      `OUTCOME: ${state.automationPrompt}`,
      '',
      `CARD: ${card.title} — ${card.body}`,
      '',
      `AGENT SUMMARY: ${info?.summary ?? 'No summary available'}`,
      `FILES MODIFIED: ${info?.filesModified?.join(', ') ?? 'None'}`,
      '',
      'Respond with EXACTLY one of:',
      'RESULT: PASS',
      'RESULT: FAIL',
      '',
      'Followed by a brief explanation.',
    ].join('\n');

    try {
      const evalAgentId = await api.agents.runQuick(evalPrompt);
      runs[runIdx] = { ...run, evaluationAgentId: evalAgentId, phase: 'evaluating' };
      await saveRuns(api, runs);
    } catch {
      addHistory(card, 'automation-failed', 'Failed to spawn evaluation agent', agentId);
      checkStuck(card, board);
      runs.splice(runIdx, 1);
      await saveRuns(api, runs);
      await saveCards(api, board, cards);
      kanBossState.triggerRefresh();
    }
    return;
  }

  // Phase: evaluating
  if (run.phase === 'evaluating') {
    const completed = api.agents.listCompleted();
    const info = completed.find((c) => c.id === agentId);

    const summary = info?.summary ?? '';
    const passed = summary.includes('RESULT: PASS');

    runs.splice(runIdx, 1);
    await saveRuns(api, runs);

    if (passed) {
      // Move card to next state
      const currentState = board.states.find((s) => s.id === card.stateId);
      if (!currentState) return;

      const sortedStates = [...board.states].sort((a, b) => a.order - b.order);
      const nextStateIdx = sortedStates.findIndex((s) => s.id === currentState.id) + 1;

      if (nextStateIdx < sortedStates.length) {
        const nextState = sortedStates[nextStateIdx];
        card.stateId = nextState.id;
        card.automationAttempts = 0;
        addHistory(card, 'automation-succeeded',
          `Automation passed — moved to "${nextState.name}"`, agentId);
        addHistory(card, 'moved', `Moved from "${currentState.name}" to "${nextState.name}"`);
        await saveCards(api, board, cards);
        kanBossState.triggerRefresh();

        // If next state is also automatic, trigger recursively
        if (nextState.isAutomatic) {
          const freshCards = await loadCards(api, board);
          const freshCard = freshCards.find((c) => c.id === card.id);
          if (freshCard) {
            await triggerAutomation(api, freshCard, board);
          }
        }
      } else {
        // Already at last state — just mark success
        addHistory(card, 'automation-succeeded', 'Automation passed (already at final state)', agentId);
        await saveCards(api, board, cards);
        kanBossState.triggerRefresh();
      }
    } else {
      const reason = summary.replace(/RESULT:\s*FAIL\s*/i, '').trim() || 'Evaluation failed';
      addHistory(card, 'automation-failed', `Automation failed: ${reason}`, agentId);
      checkStuck(card, board);
      await saveCards(api, board, cards);
      kanBossState.triggerRefresh();

      // Retry if not stuck
      if (card.automationAttempts < board.config.maxRetries) {
        await triggerAutomation(api, card, board);
      }
    }
  }
}

function checkStuck(card: Card, board: Board): void {
  if (card.automationAttempts >= board.config.maxRetries) {
    addHistory(card, 'automation-stuck',
      `Card stuck after ${card.automationAttempts} attempts (max: ${board.config.maxRetries})`);
  }
}

// ── Initialize / Shutdown ───────────────────────────────────────────────

export function initAutomationEngine(api: PluginAPI): Disposable {
  engineApi = api;

  const statusSub = api.agents.onStatusChange((agentId, status, prevStatus) => {
    if (!engineApi) return;

    const isCompleted =
      (prevStatus === 'running' && status === 'sleeping') ||
      (prevStatus === 'running' && status === 'error');

    if (!isCompleted) return;

    const outcome = status === 'sleeping' ? 'success' as const : 'error' as const;
    onAgentCompleted(engineApi, agentId, outcome);
  });

  return statusSub;
}

export function shutdownAutomationEngine(): void {
  engineApi = null;
}
