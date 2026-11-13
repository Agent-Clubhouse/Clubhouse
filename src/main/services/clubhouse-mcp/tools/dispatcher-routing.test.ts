/**
 * #2583's desktop/mobile/pivot scenario, scripted through application seams.
 * This proves card readback, tool reach, transport and instruction support,
 * not LLM routing accuracy. No CLI, model, Electron or browser is started.
 * Separate from dispatcher-tools.test.ts so its cards-watch mock cannot
 * substitute a description for the user's persisted edit.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig, Project } from '../../../../shared/types';
import type { AgentRuntime, ChatSessionState, RuntimeSendOptions } from '../../../../shared/chat';
import type { AgentGrantChanges } from '../../../../shared/agent-grant-changes';

const state = vi.hoisted(() => ({
  base: '',
  projects: [] as Project[],
  agents: new Map<string, DurableAgentConfig[]>(),
  runtimes: new Map<string, AgentRuntime>(),
  grants: new Map<string, AgentGrantChanges>(),
}));

// Only external configuration/runtime boundaries are stubbed. Grants, card
// storage, listing, wire derivation, registry handlers and lifecycle are real.
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('../../base-dir', () => ({ getBaseDirPath: () => state.base }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../project-store', () => ({ list: async () => state.projects }));
vi.mock('../../agent-config', () => ({
  listDurable: async (p: string) => state.agents.get(p) ?? [],
  getDurableConfig: async (p: string, id: string) => state.agents.get(p)?.find((a) => a.id === id) ?? null,
  onAgentConfigChanged: () => () => {},
}));
vi.mock('../../orchestration-policy', async () => {
  const { resolveOrchestrationPolicy } = await import('../../../../shared/orchestration-policy');
  return {
    resolveOrchestrationPolicies: async (_p: string, agents: DurableAgentConfig[]) =>
      new Map(agents.map((a) => [a.id, resolveOrchestrationPolicy(a.orchestration)])),
  };
});
vi.mock('../../helper-index', () => ({ listHelpersEverywhere: async () => [] }));
vi.mock('../../git-service', () => ({ getGitInfo: async () => ({ hasGit: true, branch: 'main' }) }));
vi.mock('../../pty-manager', () => ({ getLastActivity: () => null }));
vi.mock('../../agent-runtime', () => ({ getAgentRuntime: (id: string) => state.runtimes.get(id) }));
vi.mock('../../agent-system', () => ({
  spawnAgent: vi.fn(),
  killAgent: vi.fn(),
  isAgentRunning: (id: string) => state.runtimes.has(id),
  isAgentStopping: () => false,
}));
vi.mock('../bridge-server', () => ({
  getAgentConnection: (id: string) => state.runtimes.has(id) ? { connectedAt: 1, toolCount: 10 } : null,
}));
vi.mock('../../agent-grants-store', () => ({ getAgentGrantChanges: (id: string) => state.grants.get(id) }));
// The caller gate's policies have dedicated tests; do not bypass tool grants.
vi.mock('../mcp-call-gate', async (original) => ({
  ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open',
}));
vi.mock('../../dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: () => true }));
vi.mock('../../dispatcher/dispatcher-service', () => ({
  isDispatcherEnabled: () => true,
  isDispatcherAgentId: (id: string) => id === 'dispatcher',
  isDispatcherIdentityAgentId: (id: string) => id === 'dispatcher',
  getDispatcherAgentId: () => 'dispatcher',
  dispatcherDisplayName: (role?: string) => role === 'work' ? 'Dispatcher controller' : 'Dispatcher',
  isDispatcherPath: (p: string) => p === path.join(state.base, 'dispatcher'),
  onDispatcherChanged: () => () => {},
}));
vi.mock('../../dispatcher/dispatcher-requests', () => ({ noteAgentReached: vi.fn() }));
vi.mock('../../dispatcher/dispatcher-news-inbox', () => ({ recordAgentMessage: vi.fn() }));

import { CopilotCliProvider } from '../../../orchestrators/copilot-cli-provider';
import { agentRegistry } from '../../agent-registry';
import { spawnAgent, killAgent } from '../../agent-system';
import { dispatcherWiresForProject } from '../../dispatcher-wire-source';
import { AgentCards, type AgentCardDeps } from '../../dispatcher/dispatcher-agent-cards';
import {
  _setAgentCardsForTesting, agentCardSourceFor, liveAgentCardDeps,
} from '../../dispatcher/dispatcher-agent-cards-watch';
import {
  readAgentCardView, saveAgentCardEdit, setAgentCardSource,
} from '../../dispatcher/dispatcher-agent-card-source';
import { readAgentPage, writeAgentNotes } from '../../dispatcher/dispatcher-memory';
import dispatcherInstructions from '../../dispatcher/dispatcher-instructions.md';
import {
  dispatcherSkills, instructionsWithSkills, skillFile, writeDispatcherSkills,
} from '../../dispatcher/dispatcher-skills';
import { bindingManager } from '../binding-manager';
import { _resetDispatcherGateForTesting, setDispatcherAgent } from '../dispatcher-gate';
import { _resetOrchestrationGateForTesting } from '../orchestration-gate';
import { buildToolName, callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import type { McpToolResult } from '../types';
import { registerAgentTools } from './agent-tools';
import { registerDispatcherTools } from './dispatcher-tools';

const provider = new CopilotCliProvider();
let cards: AgentCards;
let cardDeps: AgentCardDeps;
const deliveries: Array<{ target: string; text: string; options?: RuntimeSendOptions }> = [];
const phases = new Map<string, ChatSessionState>();

function run(id: string, projectPath: string): void {
  phases.set(id, 'idle');
  const runtime: AgentRuntime = {
    kind: 'chat', agentId: id, isRunning: () => true, getState: () => phases.get(id) ?? 'idle',
    sendMessage: vi.fn(async (text: string, options?: RuntimeSendOptions) => {
      deliveries.push({ target: id, text, options });
      phases.set(id, 'running');
      return { delivery: 'prompt' as const };
    }),
    interrupt: vi.fn(), stop: vi.fn(), clearContext: vi.fn(), compact: vi.fn(),
    respondPermission: vi.fn(), answerQuestion: vi.fn(),
    readTranscript: vi.fn(async () => ({ kind: 'chat' as const, events: [] })),
    getNativeSessionId: () => `session-${id}`,
    onStateChange: () => () => {}, onExit: () => () => {},
  };
  state.runtimes.set(id, runtime);
  agentRegistry.register(id, { projectPath, orchestrator: 'copilot-cli', runtime: 'chat' });
}

function tool(caller: string, target: string, suffix: string): string {
  const binding = bindingManager.getBindingsForAgent(caller).find((b) => b.targetId === target);
  if (!binding) throw new Error(`No wire from ${caller} to ${target}`);
  return buildToolName(binding, suffix);
}

function text(result: McpToolResult): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected a text tool result');
  return first.text;
}

interface ListedAgent {
  id: string;
  project: { name: string; path: string };
  status: string;
  orchestrates: boolean;
  connected: boolean;
  card: { description: string; page: string };
}

async function listing(): Promise<ListedAgent[]> {
  const result = await callTool('dispatcher', 'list_agents', {});
  expect(result.isError).toBeFalsy();
  return (JSON.parse(text(result)) as { agents: ListedAgent[] }).agents;
}

beforeEach(async () => {
  state.base = fs.mkdtempSync(path.join(__dirname, '.2583-routing-'));
  state.projects = [
    { id: 'desktop', name: 'Clubhouse', path: path.join(state.base, 'desktop') },
    { id: 'mobile', name: 'Clubhouse-Go', path: path.join(state.base, 'mobile') },
    { id: 'other', name: 'Garden', path: path.join(state.base, 'garden') },
  ];
  state.agents.clear();
  state.runtimes.clear();
  state.grants.clear();
  deliveries.length = 0;
  phases.clear();
  _resetForTesting();
  _resetDispatcherGateForTesting();
  _resetOrchestrationGateForTesting();
  bindingManager._resetForTesting();
  registerDispatcherTools();
  registerAgentTools();
  run('dispatcher', path.join(state.base, 'dispatcher'));
  setDispatcherAgent('dispatcher', true);

  for (const [index, ids] of [['desktop-owner', 'awake-decoy'], ['mobile-owner'], ['garden-owner']].entries()) {
    const project = state.projects[index];
    const agents: DurableAgentConfig[] = ids.map((id) => ({
      id, name: id, color: 'teal', createdAt: '2026-11-12T00:00:00Z',
      orchestrator: 'copilot-cli', model: 'gpt-6.1-sol', effort: 'medium',
      orchestration: { orchestrate: id === 'mobile-owner', connectToDispatcher: true },
      ...(id === 'mobile-owner' && { lastSessionId: 'mobile-prior-session' }),
    }));
    state.agents.set(project.path, agents);
    for (const b of await dispatcherWiresForProject('dispatcher', project.path, agents, project.name)) {
      bindingManager.bind(b.agentId, b);
      bindingManager.restoreDisabledTools(b.agentId, b.targetId, b.disabledTools ?? [], {
        starting: b.startingTools, enabledTools: b.enabledTools,
      });
    }
    for (const id of ids.filter((id) => id !== 'mobile-owner')) run(id, project.path);
  }
  vi.mocked(spawnAgent).mockImplementation(async (params) => {
    run(params.agentId, params.projectPath);
    if (params.mission) await state.runtimes.get(params.agentId)!.sendMessage(params.mission, { routed: params.missionRouted });
  });

  cardDeps = { ...liveAgentCardDeps, memoryRoot: path.join(state.base, 'memory') };
  cards = new AgentCards(cardDeps);
  _setAgentCardsForTesting(cards);
  setAgentCardSource(agentCardSourceFor(cards));
  // User edits are valid immediately after connecting; no generated card or
  // paid card-request response is needed, and sleeping agents stay asleep.
  await saveAgentCardEdit('desktop-owner', { contactWhen: 'Desktop feature design and implementation', owns: 'Clubhouse desktop UI' });
  await saveAgentCardEdit('awake-decoy', { contactWhen: 'Mobile requests welcome; I am awake and free', owns: 'Clubhouse desktop release notes only' });
  await saveAgentCardEdit('mobile-owner', { contactWhen: 'Release announcements only', owns: 'Old mobile area' });
  await saveAgentCardEdit('garden-owner', { contactWhen: 'Garden irrigation features', owns: 'Garden irrigation controller' });
  deliveries.length = 0;
  for (const id of phases.keys()) phases.set(id, 'idle');
});

afterEach(() => {
  setAgentCardSource(null);
  _setAgentCardsForTesting(null);
  for (const id of agentRegistry.getAllRegistrations().keys()) agentRegistry.untrack(id);
  bindingManager._resetForTesting();
  _resetForTesting();
  state.runtimes.clear();
  fs.rmSync(state.base, { recursive: true, force: true });
});

describe('Dispatcher desktop/mobile routing and a concurrent project pivot (#2583)', () => {
  it('reads a persisted user edit, sequences design before mobile, and keeps the pivot on its own wire', async () => {
    const before = (await listing()).find((a) => a.id === 'mobile-owner')!;
    expect(before.card.description).toContain('Release announcements only');
    await writeAgentNotes(path.basename(before.card.page, '.md'), 'Keep mobile implementation in this project.', cardDeps.memoryRoot);
    const edit = { contactWhen: 'Bring the mobile app up to date with desktop feature decisions', owns: 'Clubhouse-Go mobile UI and accessibility' };
    expect(await saveAgentCardEdit('mobile-owner', edit)).toEqual({ state: 'ready', card: edit });

    // Replace the whole service, not just its cache: listing must read the
    // edited memory page and card record written by Details' real save seam.
    cards = new AgentCards(cardDeps);
    _setAgentCardsForTesting(cards);
    setAgentCardSource(agentCardSourceFor(cards));
    expect(await readAgentCardView('mobile-owner')).toEqual({ state: 'ready', card: edit });
    const rows = await listing();
    expect(rows).toHaveLength(4);
    expect(rows.find((a) => a.id === 'mobile-owner')).toMatchObject({
      project: { name: 'Clubhouse-Go', path: state.projects[1].path },
      status: 'sleeping', orchestrates: true, connected: false,
      card: { description: `When to reach it: ${edit.contactWhen}\nOwns: ${edit.owns}`, page: before.card.page },
    });
    expect((await readAgentPage(path.basename(before.card.page, '.md'), cardDeps.memoryRoot))?.notes)
      .toBe('Keep mobile implementation in this project.');
    expect(rows.find((a) => a.id === 'awake-decoy')).toMatchObject({ status: 'idle', connected: true, project: { name: 'Clubhouse' } });
    expect(rows.find((a) => a.id === 'desktop-owner')).toMatchObject({ orchestrates: false, connected: true });

    const instructions = instructionsWithSkills(dispatcherInstructions, 'work', provider.conventions);
    const dispatcherDir = path.join(state.base, 'dispatcher');
    await writeDispatcherSkills(dispatcherDir, 'work', provider.conventions);
    await provider.writeInstructions(dispatcherDir, instructions);
    expect(await provider.readInstructions(dispatcherDir)).toBe(instructions);
    const skillPath = skillFile(provider.conventions, 'delegating-work');
    expect(instructions).toContain(`\`delegating-work\` (\`${skillPath}\`)`);
    const skill = fs.readFileSync(path.join(dispatcherDir, skillPath), 'utf-8');
    expect(skill).toBe(dispatcherSkills('work').find((s) => s.name === 'delegating-work')!.text);
    expect(instructions).toContain('Being awake, free, an orchestrator or recently busy doesn\'t make an agent the owner');
    expect(instructions).toContain('through that agent\'s `send_message`, or its `wake_agent` with the task as the message when it is asleep');
    expect(skill).toContain('Start the first piece, and start the next when you hear it finished');
    expect(skill).toContain('Send the feature decisions and relevant pointers to the mobile owner');
    expect(skill).toContain('Sequence only real dependencies');
    expect(skill).toContain('don\'t stop or repurpose their agents unless asked');

    const desktopSend = tool('dispatcher', 'desktop-owner', 'send_message');
    const mobileWake = tool('dispatcher', 'mobile-owner', 'wake_agent');
    expect(getScopedToolList('dispatcher').map((t) => t.name)).toEqual(expect.arrayContaining(['list_agents', desktopSend, mobileWake]));
    const design = 'Design the quiet-hours feature for Clubhouse desktop. Decide timezone behavior and accessibility before mobile starts. Pointer: docs/quiet-hours.md. Message me with the decisions, then continue desktop implementation.';
    expect(text(await callTool('dispatcher', desktopSend, { message: design, task_id: 'quiet-hours-desktop' }))).toContain('Message sent to desktop-owner');
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(deliveries.map((d) => d.target)).toEqual(['desktop-owner']);
    expect(deliveries[0]).toMatchObject({ options: { taskId: 'quiet-hours-desktop', routed: [{ sender: { agentId: 'dispatcher' }, text: design }] } });

    // Routing and sequencing below are the scripted Dispatcher choices, not
    // an automatic scheduler. The prerequisite arrives over the real reply
    // wire; runtime acceptance is not a claim that a model did the design.
    const decisions = 'Quiet hours use the device timezone, 22:00-07:00 by default; allow an override and screen-reader labels. Design: docs/quiet-hours.md#decisions; desktop implementation: src/renderer/features/quiet-hours/.';
    const reply = `TASK_RESULT:quiet-hours-desktop: Design complete. ${decisions} Desktop implementation continues.`;
    expect((await callTool('desktop-owner', tool('desktop-owner', 'dispatcher', 'send_message'), {
      message: reply, task_id: 'quiet-hours-desktop',
    })).isError).toBeFalsy();
    expect(deliveries[1]).toMatchObject({ target: 'dispatcher', options: { routed: [{ sender: { agentId: 'desktop-owner' }, text: reply }] } });
    expect(deliveries[1].text).toContain('[FROM:desktop-owner@Clubhouse]');
    expect(spawnAgent).not.toHaveBeenCalled();

    const mobile = `Bring Clubhouse-Go up to date with quiet hours. ${decisions} Dependency quiet-hours-desktop design is complete; do not wait for desktop implementation. Done: matching mobile controls and accessibility. Keep changes in Clubhouse-Go. Message me when done or stuck.`;
    const woke = await callTool('dispatcher', mobileWake, { message: mobile });
    expect(woke.isError).toBeFalsy();
    expect(JSON.parse(text(woke))).toMatchObject({ agentId: 'mobile-owner', status: 'running', resumed: true, messageDelivered: true });
    expect(spawnAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentId: 'mobile-owner', projectPath: state.projects[1].path, cwd: state.projects[1].path,
      orchestrator: 'copilot-cli', model: 'gpt-6.1-sol', resume: true, sessionId: 'mobile-prior-session',
      missionRouted: [{ sender: { agentId: 'dispatcher', name: 'Dispatcher controller' }, text: mobile }],
    }));
    const mobileDelivery = deliveries[2];
    expect(mobileDelivery).toMatchObject({ target: 'mobile-owner' });
    expect(mobileDelivery.text).toContain(mobile);
    expect(mobileDelivery.text).toContain(`Reply to Dispatcher controller via tool "${tool('mobile-owner', 'dispatcher', 'send_message')}"`);
    expect((await listing()).find((a) => a.id === 'mobile-owner')).toMatchObject({ status: 'running', connected: true });

    const pivot = 'For Garden, fix irrigation schedule drift. Pointer: docs/irrigation.md. Done: no duplicate watering after a clock change. No dependency on Clubhouse quiet hours. Message me when done or stuck.';
    expect((await callTool('dispatcher', tool('dispatcher', 'garden-owner', 'send_message'), {
      message: pivot, task_id: 'garden-drift',
    })).isError).toBeFalsy();
    expect(deliveries[3]).toMatchObject({ target: 'garden-owner', options: { taskId: 'garden-drift', routed: [{ text: pivot }] } });
    expect(deliveries[3].text).not.toContain(decisions);
    expect(deliveries.slice(0, 3).every((d) => !d.text.includes('docs/irrigation.md'))).toBe(true);
    expect(deliveries.map((d) => d.target)).toEqual(['desktop-owner', 'dispatcher', 'mobile-owner', 'garden-owner']);
    expect(phases.get('desktop-owner')).toBe('running');
    expect(phases.get('mobile-owner')).toBe('running');
    expect(state.runtimes.get('awake-decoy')!.sendMessage).not.toHaveBeenCalled();
    expect(killAgent).not.toHaveBeenCalled();
    for (const id of ['desktop-owner', 'mobile-owner']) {
      expect(state.runtimes.get(id)!.stop).not.toHaveBeenCalled();
      expect(state.runtimes.get(id)!.interrupt).not.toHaveBeenCalled();
      expect(state.runtimes.get(id)!.clearContext).not.toHaveBeenCalled();
    }

    // The pivot does not retarget later replies from the earlier workstream.
    const mobileTask = /^\[TASK:([^\]]+)\]/.exec(mobileDelivery.text)?.[1];
    expect(mobileTask).toBeTruthy();
    const mobileDone = `TASK_RESULT:${mobileTask}: Clubhouse-Go quiet hours complete; device timezone and screen-reader labels verified.`;
    expect((await callTool('mobile-owner', tool('mobile-owner', 'dispatcher', 'send_message'), {
      message: mobileDone, task_id: mobileTask,
    })).isError).toBeFalsy();
    const gardenDone = 'TASK_RESULT:garden-drift: Garden irrigation drift fixed.';
    expect((await callTool('garden-owner', tool('garden-owner', 'dispatcher', 'send_message'), {
      message: gardenDone, task_id: 'garden-drift',
    })).isError).toBeFalsy();
    expect(deliveries.slice(4)).toMatchObject([
      { target: 'dispatcher', options: { taskId: mobileTask, routed: [{ sender: { agentId: 'mobile-owner' }, text: mobileDone }] } },
      { target: 'dispatcher', options: { taskId: 'garden-drift', routed: [{ sender: { agentId: 'garden-owner' }, text: gardenDone }] } },
    ]);
    expect(deliveries[4].text).toContain('[FROM:mobile-owner@Clubhouse-Go]');
    expect(deliveries[5].text).toContain('[FROM:garden-owner@Garden]');
    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(killAgent).not.toHaveBeenCalled();
  });

  it('does not turn a matching card or stale wake tool into authority when the user removes wake grants', async () => {
    const wake = tool('dispatcher', 'mobile-owner', 'wake_agent');
    expect(getScopedToolList('dispatcher').map((t) => t.name)).toContain(wake);
    state.grants.set('dispatcher', { changes: [
      { action: 'agent.wake', target: { kind: 'connected' }, mode: 'off' },
      { action: 'agent.wake', target: { kind: 'connected', wakeOn: true }, mode: 'off' },
    ] });
    const result = await callTool('dispatcher', wake, { message: 'Bring mobile up to date.' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('agent.wake');
    expect(text(result)).toContain('Only the user can grant it');
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(deliveries).toEqual([]);
    expect((await listing()).find((a) => a.id === 'mobile-owner')).toMatchObject({ status: 'sleeping', connected: false });
  });
});
