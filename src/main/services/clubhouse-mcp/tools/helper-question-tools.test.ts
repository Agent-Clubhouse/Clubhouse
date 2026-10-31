import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DurableAgentConfig } from '../../../../shared/types';
import type { ChatEventDataMap, ChatQuestion } from '../../../../shared/chat';

// ── Mocks: no CLI or disk is touched ───────────────────────────────────────

const agents = new Map<string, DurableAgentConfig>();
vi.mock('../../agent-config', () => ({
  getDurableConfig: vi.fn(async (_projectPath: string, id: string) => agents.get(id) ?? null),
}));

// The parent is read from its own project: parentProjectPath when set (#2513).
vi.mock('../../helper-index', () => ({
  findParent: vi.fn(async (helperPath: string, helper: DurableAgentConfig) => {
    const config = helper.parentAgentId ? agents.get(helper.parentAgentId) : undefined;
    return config ? { projectPath: helper.parentProjectPath || helperPath, config } : null;
  }),
}));

const mockGetPolicy = vi.fn();
vi.mock('../../orchestration-policy', () => ({
  getOrchestrationPolicy: (...args: unknown[]) => mockGetPolicy(...args),
}));

interface FakeRuntime {
  sent: string[];
  pending: Set<string>;
  answers: Array<{ requestId: string; answers: unknown }>;
  escalated: Array<{ requestId: string; notice: string }>;
  exitListeners: Set<() => void>;
  refuse?: boolean;
}
const runtimes = new Map<string, FakeRuntime>();
function fakeRuntime(id: string): FakeRuntime {
  const rt: FakeRuntime = { sent: [], pending: new Set(), answers: [], escalated: [], exitListeners: new Set() };
  runtimes.set(id, rt);
  return rt;
}
vi.mock('../../agent-runtime', () => ({
  getAgentRuntime: (id: string) => {
    const rt = runtimes.get(id);
    if (!rt) return undefined;
    return {
      isRunning: () => true,
      sendMessage: async (text: string) => {
        if (rt.refuse) throw new AgentStoppingError(id);
        rt.sent.push(text);
        return { delivery: 'prompt' };
      },
      hasPendingQuestion: (requestId: string) => rt.pending.has(requestId),
      answerQuestion: async (requestId: string, answers: unknown) => {
        rt.pending.delete(requestId);
        rt.answers.push({ requestId, answers });
      },
      escalateQuestion: async (requestId: string, notice: string) => {
        if (!rt.pending.has(requestId)) return false;
        rt.escalated.push({ requestId, notice });
        return true;
      },
      onExit: (listener: () => void) => {
        rt.exitListeners.add(listener);
        return () => { rt.exitListeners.delete(listener); };
      },
    };
  },
}));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

import { AgentStoppingError } from '../../agent-runtime/agent-stopping';
import {
  formatHelperQuestion,
  parseHelperAnswers,
  registerHelperQuestionTools,
  routeHelperQuestion,
  _resetHelperQuestionsForTesting,
} from './helper-question-tools';
import { deliverHelperUpdate, _resetHelperDeliveryForTesting } from './helper-delivery';
import { callTool, _resetForTesting } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import { setOrchestrationEnabled, _resetOrchestrationGateForTesting } from '../orchestration-gate';

// ── Fixtures ───────────────────────────────────────────────────────────────

const PROJECT = path.join(path.sep, 'tmp', 'project');

const BRANCH: ChatQuestion = {
  id: 'Which branch?',
  prompt: 'Which branch?',
  header: 'Branch',
  options: [{ id: 'main', label: 'main', description: 'The default' }, { id: 'dev', label: 'dev' }],
  multiSelect: false,
  allowFreeText: true,
};
const AREAS: ChatQuestion = {
  id: 'areas',
  prompt: 'Which areas?',
  options: [{ id: 'ui', label: 'UI' }, { id: 'api', label: 'API' }],
  multiSelect: true,
  allowFreeText: false,
};

function addAgent(config: Partial<DurableAgentConfig> & { id: string }): void {
  agents.set(config.id, { name: config.id, color: 'indigo', createdAt: '2026-10-19T10:00:00.000Z', orchestrator: 'claude-code', ...config });
}

function run(id: string, orchestrate = false): FakeRuntime {
  agentRegistry.register(id, { projectPath: PROJECT, orchestrator: 'claude-code', runtime: 'chat' });
  setOrchestrationEnabled(id, orchestrate);
  return fakeRuntime(id);
}

function question(requestId: string, questions: ChatQuestion[]): ChatEventDataMap['question'] {
  return { requestId, questions };
}

/** Route a question from `helper` and return the request id the parent was given. */
async function ask(helper: FakeRuntime, requestId: string, questions: ChatQuestion[], parent: FakeRuntime): Promise<string> {
  helper.pending.add(requestId);
  const route = await routeHelperQuestion('helper', question(requestId, questions));
  expect(route).toEqual({ agentId: 'orch', name: 'Orch' });
  const id = /requestId "(hq_[a-z0-9]+)"/.exec(parent.sent.at(-1) ?? '')?.[1];
  expect(id).toBeDefined();
  return id!;
}

let orch: FakeRuntime;
let helper: FakeRuntime;

beforeEach(() => {
  vi.clearAllMocks();
  agents.clear();
  runtimes.clear();
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  _resetForTesting();
  _resetOrchestrationGateForTesting();
  _resetHelperQuestionsForTesting();
  _resetHelperDeliveryForTesting();
  registerHelperQuestionTools();

  mockGetPolicy.mockResolvedValue({ orchestrate: true, access: 'same', control: 'hands-off', maxHelpers: 5 });
  addAgent({ id: 'orch', name: 'Orch' });
  addAgent({ id: 'helper', name: 'Fixer', parentAgentId: 'orch' });
  orch = run('orch', true);
  helper = run('helper');
});

// ── Routing ────────────────────────────────────────────────────────────────

describe('routeHelperQuestion', () => {
  it('sends a hands-off helper\'s question to its parent, not the user', async () => {
    const id = await ask(helper, 'q1', [BRANCH], orch);
    expect(mockGetPolicy).toHaveBeenCalledWith(PROJECT, 'orch');
    const text = orch.sent[0];
    expect(text).toContain('[QUESTION FROM HELPER:Fixer (helper)]');
    expect(text).toContain(`answer_helper_question, requestId "${id}"`);
    expect(text).toContain('escalate: true');
    expect(text).toContain('1. Branch. Which branch?');
    expect(text).toContain('Options: "main" (The default); "dev"');
  });

  it.each(['ask-before-start', 'ask-everything'] as const)('leaves the question with the user under %s', async (control) => {
    mockGetPolicy.mockResolvedValue({ orchestrate: true, access: 'same', control, maxHelpers: 5 });
    expect(await routeHelperQuestion('helper', question('q1', [BRANCH]))).toBeNull();
    expect(orch.sent).toEqual([]);
  });

  it('leaves the question with the user when the parent no longer orchestrates', async () => {
    mockGetPolicy.mockResolvedValue({ orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5 });
    expect(await routeHelperQuestion('helper', question('q1', [BRANCH]))).toBeNull();
  });

  it('leaves an agent without a parent, or with a disposed parent, asking the user', async () => {
    addAgent({ id: 'plain' });
    run('plain');
    expect(await routeHelperQuestion('plain', question('q1', [BRANCH]))).toBeNull();
    addAgent({ id: 'orch', name: 'Orch', disposedAt: '2026-10-19T11:00:00.000Z' });
    expect(await routeHelperQuestion('helper', question('q1', [BRANCH]))).toBeNull();
    expect(orch.sent).toEqual([]);
  });

  it('sends the question to a parent in another project, under that project\'s policy', async () => {
    const orchProject = path.join(path.sep, 'tmp', 'orchestrator-project');
    addAgent({ id: 'helper', name: 'Fixer', parentAgentId: 'orch', parentProjectPath: orchProject });
    await ask(helper, 'q1', [BRANCH], orch);
    expect(mockGetPolicy).toHaveBeenCalledWith(orchProject, 'orch');
    expect(mockGetPolicy).not.toHaveBeenCalledWith(PROJECT, 'orch');
    expect(orch.sent[0]).toContain('[QUESTION FROM HELPER:Fixer (helper)]');
  });

  it('asks the user when the parent is asleep or shutting down', async () => {
    orch.refuse = true;
    expect(await routeHelperQuestion('helper', question('q1', [BRANCH]))).toBeNull();
    runtimes.delete('orch');
    expect(await routeHelperQuestion('helper', question('q2', [BRANCH]))).toBeNull();
  });
});

// ── answer_helper_question ─────────────────────────────────────────────────

describe('answer_helper_question', () => {
  it('answers the helper, matching option labels', async () => {
    const id = await ask(helper, 'q1', [BRANCH], orch);
    const result = await callTool('orch', 'answer_helper_question', { requestId: id, answer: 'DEV' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Answered. Fixer carries on.');
    expect(helper.answers).toEqual([{ requestId: 'q1', answers: { 'Which branch?': 'dev' } }]);

    // The question is gone once answered.
    const again = await callTool('orch', 'answer_helper_question', { requestId: id, answer: 'main' });
    expect(again.isError).toBe(true);
  });

  it('takes several answers keyed by question number', async () => {
    const id = await ask(helper, 'q1', [BRANCH, AREAS], orch);
    const result = await callTool('orch', 'answer_helper_question', { requestId: id, answers: { 1: 'release/2', 2: ['ui', 'Api'] } });
    expect(result.isError).toBeFalsy();
    expect(helper.answers[0].answers).toEqual({ 'Which branch?': 'release/2', areas: ['ui', 'api'] });
  });

  it('escalates to the user when asked', async () => {
    const id = await ask(helper, 'q1', [BRANCH], orch);
    const result = await callTool('orch', 'answer_helper_question', { requestId: id, escalate: true });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Passed Fixer\'s question to the user');
    expect(helper.escalated).toEqual([{ requestId: 'q1', notice: 'Orch passed this question to you.' }]);
    expect(helper.answers).toEqual([]);
  });

  it('passes open questions to the user when the parent stops before answering', async () => {
    const id = await ask(helper, 'q1', [BRANCH], orch);
    await ask(helper, 'q2', [BRANCH], orch);
    expect(orch.exitListeners.size).toBe(1);
    for (const listener of [...orch.exitListeners]) listener();
    await Promise.resolve();
    expect(helper.escalated).toEqual([
      { requestId: 'q1', notice: 'Orch stopped before answering, so this question is yours.' },
      { requestId: 'q2', notice: 'Orch stopped before answering, so this question is yours.' },
    ]);
    expect(orch.exitListeners.size).toBe(0);
    const result = await callTool('orch', 'answer_helper_question', { requestId: id, answer: 'main' });
    expect(result.isError).toBe(true);
  });

  it('refuses another orchestrator\'s question', async () => {
    const id = await ask(helper, 'q1', [BRANCH], orch);
    addAgent({ id: 'other', name: 'Other' });
    run('other', true);
    const result = await callTool('other', 'answer_helper_question', { requestId: id, answer: 'main' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No open helper question');
    expect(helper.answers).toEqual([]);
  });

  it('says so when the user answered first', async () => {
    const id = await ask(helper, 'q1', [BRANCH], orch);
    helper.pending.delete('q1');
    const result = await callTool('orch', 'answer_helper_question', { requestId: id, answer: 'main' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no longer open');
  });

  it('is only for agents with orchestration on', async () => {
    setOrchestrationEnabled('orch', false);
    const result = await callTool('orch', 'answer_helper_question', { requestId: 'hq_x', answer: 'main' });
    expect(result.isError).toBe(true);
  });
});

describe('parseHelperAnswers', () => {
  it('refuses an answer that is not an option when free text is off', () => {
    expect(() => parseHelperAnswers([AREAS], { answer: 'docs' })).toThrow('"docs" is not an option for question 1. Pick one of: "UI", "API".');
  });

  it('refuses several answers to a pick-one question', () => {
    expect(() => parseHelperAnswers([BRANCH], { answer: ['main', 'dev'] })).toThrow('Question 1 takes one answer.');
  });

  it('needs answers keyed by number when there are several questions, and every one answered', () => {
    expect(() => parseHelperAnswers([BRANCH, AREAS], { answer: 'main' })).toThrow('There are 2 questions');
    expect(() => parseHelperAnswers([BRANCH, AREAS], { answers: { 1: 'main' } })).toThrow('Missing an answer for question 2.');
    expect(() => parseHelperAnswers([BRANCH], { answers: { 3: 'main' } })).toThrow('Unknown question "3"');
    expect(() => parseHelperAnswers([BRANCH], {})).toThrow('Give answer');
  });

  it('accepts a question\'s header or id as the key', () => {
    expect(parseHelperAnswers([BRANCH, AREAS], { answers: { branch: 'main', areas: 'UI' } })).toEqual({ 'Which branch?': 'main', areas: ['ui'] });
  });
});

describe('formatHelperQuestion', () => {
  it('lists every question with its options and how to answer', () => {
    expect(formatHelperQuestion({ id: 'h', name: 'H' }, 'hq_1', [BRANCH, AREAS])).toBe([
      '[QUESTION FROM HELPER:H (h)] H is waiting for your answer. Answer with answer_helper_question, requestId "hq_1". ' +
        'If the user should decide, call it with escalate: true instead.',
      '1. Branch. Which branch?',
      '   Options: "main" (The default); "dev"',
      '   Pick one. Your own text is fine too.',
      '2. Which areas?',
      '   Options: "UI"; "API"',
      '   Pick one or more.',
    ].join('\n'));
  });
});

describe('routeHelperQuestion with batched helper updates (#2414)', () => {
  it('sends the question at once, after the updates still in the delivery window', async () => {
    // The fake runtime isn't a chat runtime, so updates wait out the window, as for a terminal.
    const update = deliverHelperUpdate('orch', '[FROM HELPER:Fixer (helper)] halfway');
    expect(orch.sent).toEqual([]);
    await ask(helper, 'q-batch', [BRANCH], orch);
    await expect(update).resolves.toBe('delivered');
    expect(orch.sent).toHaveLength(2);
    expect(orch.sent[0]).toBe('[FROM HELPER:Fixer (helper)] halfway');
    expect(orch.sent[1]).toMatch(/^\[QUESTION FROM HELPER:Fixer \(helper\)\]/);
  });
});
