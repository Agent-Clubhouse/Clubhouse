// Hand-built `codex app-server` v2 messages for unit tests. Each one is
// typed with the vendored bindings, so a regeneration
// that changes a shape breaks typecheck here instead of silently drifting.
// These are not recordings; replace them with the fixture record/replay
// harness's captures once that lands.

import type {
  InitializeResponse,
  ServerNotification,
  ServerRequest,
  Thread,
  ThreadItem,
  Turn,
} from '..';
import { CODEX_APP_SERVER_SCHEMA_VERSION } from '../generated-meta';
import type { ThreadListResponse } from '../generated/v2/ThreadListResponse';
import type { ThreadResumeResponse } from '../generated/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from '../generated/v2/ThreadStartResponse';
import type { TurnStartResponse } from '../generated/v2/TurnStartResponse';
import type { TurnSteerResponse } from '../generated/v2/TurnSteerResponse';
import type { GetAccountRateLimitsResponse } from '../generated/v2/GetAccountRateLimitsResponse';

export const THREAD_ID = '019a0000-0000-7000-8000-00000000a001';
export const TURN_ID = '019a0000-0000-7000-8000-00000000b001';
export const SECOND_TURN_ID = '019a0000-0000-7000-8000-00000000b002';
const CWD = 'workspace';

type Item<T extends ThreadItem['type']> = Extract<ThreadItem, { type: T }>;
type Notification<M extends ServerNotification['method']> = Extract<ServerNotification, { method: M }>;
type Request<M extends ServerRequest['method']> = Extract<ServerRequest, { method: M }>;

export const initializeResult: InitializeResponse = {
  userAgent: `codex_cli_rs/${CODEX_APP_SERVER_SCHEMA_VERSION} (clubhouse; test)`,
  codexHome: 'codex-home',
  platformFamily: 'unix',
  platformOs: 'macos',
};

export const thread: Thread = {
  id: THREAD_ID,
  sessionId: THREAD_ID,
  originator: null,
  forkedFromId: null,
  parentThreadId: null,
  preview: '',
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: 'paginated',
  modelProvider: 'openai',
  model: 'gpt-5-codex',
  reasoningEffort: null,
  createdAt: 1_760_600_000,
  updatedAt: 1_760_600_000,
  recencyAt: null,
  status: { type: 'idle' },
  path: null,
  cwd: CWD,
  cliVersion: CODEX_APP_SERVER_SCHEMA_VERSION,
  source: 'appServer',
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
};

const threadSessionFields: ThreadStartResponse = {
  thread,
  model: 'gpt-5-codex',
  modelProvider: 'openai',
  serviceTier: null,
  disabledPluginIds: [],
  cwd: CWD,
  instructionSources: [],
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: {
    type: 'workspaceWrite',
    writableRoots: [CWD],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  reasoningEffort: null,
};

export const threadStartResult: ThreadStartResponse = { ...threadSessionFields };

export const threadResumeResult: ThreadResumeResponse = {
  ...threadSessionFields,
  collaborationMode: null,
  turnsBackwardsCursor: null,
  itemsBackwardsCursor: null,
};

export const threadListResult: ThreadListResponse = {
  data: [thread],
  nextCursor: null,
  backwardsCursor: null,
};

function turn(id: string, status: Turn['status'], extra: Partial<Turn> = {}): Turn {
  return {
    id,
    rootTurnId: null,
    items: [],
    itemsView: 'notLoaded',
    status,
    error: null,
    startedAt: 1_760_600_001,
    completedAt: status === 'inProgress' ? null : 1_760_600_009,
    durationMs: status === 'inProgress' ? null : 8_000,
    ...extra,
  };
}

export const turnStartResult: TurnStartResponse = { turn: turn(TURN_ID, 'inProgress') };
export const turnSteerResult: TurnSteerResponse = { turnId: TURN_ID };

export const rateLimitsResult: GetAccountRateLimitsResponse = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_760_610_000 },
    secondary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 1_761_000_000 },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  ordinaryUsageAllowed: null,
  rateLimitResetCredits: null,
  accountId: null,
  rateLimitUpsell: null,
};

const userMessage: Item<'userMessage'> = {
  type: 'userMessage',
  id: 'item-user-1',
  clientId: null,
  content: [{ type: 'text', text: 'Fix the failing test', text_elements: [] }],
};

const agentMessage: Item<'agentMessage'> = {
  type: 'agentMessage',
  id: 'item-agent-1',
  text: 'Running the tests.',
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
};

const commandExecution: Item<'commandExecution'> = {
  type: 'commandExecution',
  id: 'item-cmd-1',
  pluginId: null,
  scriptPath: null,
  command: 'npm test',
  cwd: CWD,
  processId: null,
  source: 'agent',
  status: 'inProgress',
  commandActions: [{ type: 'unknown', command: 'npm test' }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
};

const fileChange: Item<'fileChange'> = {
  type: 'fileChange',
  id: 'item-patch-1',
  changes: [{ path: 'src/math.ts', kind: { type: 'update', move_path: null }, diff: '-a\n+b\n' }],
  status: 'inProgress',
};

const at = { threadId: THREAD_ID, turnId: TURN_ID };

/** A turn that streams text, runs a command, edits a file and completes. */
export const completedTurnNotifications: ServerNotification[] = [
  { method: 'thread/status/changed', params: { threadId: THREAD_ID, status: { type: 'active', activeFlags: [] } } },
  { method: 'turn/started', params: { threadId: THREAD_ID, turn: turn(TURN_ID, 'inProgress') } },
  { method: 'item/started', params: { ...at, item: userMessage, startedAtMs: 1 } },
  { method: 'item/completed', params: { ...at, item: userMessage, completedAtMs: 2 } },
  { method: 'item/reasoning/summaryTextDelta', params: { ...at, itemId: 'item-reason-1', delta: 'Looking at tests', summaryIndex: 0 } },
  { method: 'item/started', params: { ...at, item: { ...agentMessage, text: '' }, startedAtMs: 3 } },
  { method: 'item/agentMessage/delta', params: { ...at, itemId: agentMessage.id, delta: 'Running ' } },
  { method: 'item/agentMessage/delta', params: { ...at, itemId: agentMessage.id, delta: 'the tests.' } },
  { method: 'item/completed', params: { ...at, item: agentMessage, completedAtMs: 4 } },
  {
    method: 'turn/plan/updated',
    params: {
      ...at,
      explanation: 'Two steps',
      plan: [
        { step: 'Run tests', status: 'inProgress' },
        { step: 'Fix failure', status: 'pending' },
      ],
    },
  },
  { method: 'item/started', params: { ...at, item: commandExecution, startedAtMs: 5 } },
  { method: 'item/commandExecution/outputDelta', params: { ...at, itemId: commandExecution.id, delta: 'FAIL math.test.ts\n' } },
  {
    method: 'item/completed',
    params: {
      ...at,
      item: { ...commandExecution, status: 'completed', aggregatedOutput: 'FAIL math.test.ts\n', exitCode: 1, durationMs: 900 },
      completedAtMs: 6,
    },
  },
  { method: 'item/fileChange/patchUpdated', params: { ...at, itemId: fileChange.id, changes: fileChange.changes } },
  { method: 'turn/diff/updated', params: { ...at, diff: 'diff --git a/src/math.ts b/src/math.ts\n' } },
  {
    method: 'thread/tokenUsage/updated',
    params: {
      ...at,
      tokenUsage: {
        total: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 },
        last: { totalTokens: 300, inputTokens: 250, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 },
        modelContextWindow: 272_000,
      },
    },
  },
  { method: 'account/rateLimits/updated', params: { rateLimits: rateLimitsResult.rateLimits } },
  {
    method: 'error',
    params: {
      ...at,
      willRetry: true,
      error: { message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null, misalignment: null },
    },
  },
  { method: 'turn/completed', params: { threadId: THREAD_ID, turn: turn(TURN_ID, 'completed') } },
  { method: 'thread/status/changed', params: { threadId: THREAD_ID, status: { type: 'idle' } } },
];

export const failedTurnCompleted: Notification<'turn/completed'> = {
  method: 'turn/completed',
  params: {
    threadId: THREAD_ID,
    turn: turn(SECOND_TURN_ID, 'failed', {
      error: { message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null },
    }),
  },
};

export const interruptedTurnCompleted: Notification<'turn/completed'> = {
  method: 'turn/completed',
  params: { threadId: THREAD_ID, turn: turn(TURN_ID, 'interrupted') },
};

export const secondTurnStarted: Notification<'turn/started'> = {
  method: 'turn/started',
  params: { threadId: THREAD_ID, turn: turn(SECOND_TURN_ID, 'inProgress') },
};

export const commandApprovalRequest: Request<'item/commandExecution/requestApproval'> = {
  method: 'item/commandExecution/requestApproval',
  id: 0,
  params: {
    kind: 'command',
    ...at,
    itemId: commandExecution.id,
    startedAtMs: 5,
    approvalId: null,
    environmentId: null,
    reason: 'needs network to install deps',
    networkApprovalContext: null,
    command: 'npm install',
    cwd: CWD,
    commandActions: [{ type: 'unknown', command: 'npm install' }],
    proposedExecpolicyAmendment: ['npm', 'install'],
    proposedNetworkPolicyAmendments: [{ host: 'registry.npmjs.org', action: 'allow' }],
  },
};

export const fileChangeApprovalRequest: Request<'item/fileChange/requestApproval'> = {
  method: 'item/fileChange/requestApproval',
  id: 1,
  params: { ...at, itemId: fileChange.id, startedAtMs: 7, reason: null, grantRoot: null },
};

export const serverRequestResolved: Notification<'serverRequest/resolved'> = {
  method: 'serverRequest/resolved',
  params: { threadId: THREAD_ID, requestId: 1 },
};
