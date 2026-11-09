import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plugin-manifest-registry', () => ({ getManifest: vi.fn(() => ({ permissions: ['mcp.tools'] })) }));
vi.mock('../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => true,
}));
vi.mock('./mcp-call-gate', async (original) => ({ ...await original<typeof import('./mcp-call-gate')>(), mcpCallAccess: () => 'open' }));

import { getScopedToolList, setDispatcherConnectionCheck, _resetForTesting } from './tool-registry';
import { mcpAdapter } from './mcp-adapter';
import { registerClubhouseMcpTools } from './tools/register-all';
import { setMcpCaller, _resetMcpCallGateForTesting } from './mcp-call-gate';
import { _resetDispatcherGateForTesting, setDispatcherAgent, setDispatcherChatAgent } from './dispatcher-gate';
import type { McpToolDefinition } from './types';
import { ClaudeCodeProvider } from '../../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../../orchestrators/codex-cli-provider';
import { CopilotCliProvider } from '../../orchestrators/copilot-cli-provider';
import { DISPATCHER_CHAT_INSTRUCTIONS, DISPATCHER_INSTRUCTIONS } from '../dispatcher/dispatcher-service';
import { dispatcherSkills, skillsSection } from '../dispatcher/dispatcher-skills';
import { defaultChatDelivery } from '../dispatcher/dispatcher-channel';
import { buildRewritePrompt } from '../dispatcher/dispatcher-rewrite';
import { PERSONALITY_PRESET_TEXT, personalityInstructions } from '../../../shared/dispatcher-personality';

/**
 * What the Dispatcher's two agents are told, and the tools they read (#3051).
 *
 * The chat the user talks to is one Dispatcher: nothing it is told, and so
 * nothing it learns to say, may mention a second session, the agent that does
 * the work, or how a request travels to it. dispatcher-copy.test.ts keeps the
 * word list for all app text; the chat's text is held to a stricter one here.
 *
 * Quality isn't judged here: that comes from collected data (#2920), never a
 * model call in CI. These check shape, words and length.
 */

const PROVIDERS = [new ClaudeCodeProvider(), new CodexCliProvider(), new CopilotCliProvider()];

/** dispatcher-copy.test.ts's list: a coordinator, a second session, the cards' internal name. */
const NAMES_A_SECOND_SESSION = /\bcoordinators?\b|\b(?:second|hidden|background|two|other) (?:agent )?sessions?\b|\bphone ?book\b/i;
/** Ways the chat could learn to describe how its requests are carried out. */
const DESCRIBES_THE_SPLIT = [
  /\b(?:separate|another|second|hidden|other|background|parallel) (?:conversations?|instances?|copy of you|copies of you|assistants?)\b/i,
  /\bbehind the scenes\b/i,
  /\bhand(?:s|ed|ing)?(?:[- ]| \w+ )offs?\b/i,
  /\bworkers?\b/i,
  // The tools and tags that join its two agents.
  /\btell_user\b|\[HAND-OFF\]/,
];

/** Every description in a tool definition: the tool's and each argument's, however deep. */
function descriptions(def: McpToolDefinition): string[] {
  const out = [def.description];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') out.push(value);
      else walk(value);
    }
  };
  walk(def.inputSchema);
  return out;
}

function tools(agentId: string): McpToolDefinition[] {
  return getScopedToolList(agentId);
}

beforeEach(() => {
  _resetForTesting();
  mcpAdapter._resetForTesting();
  _resetMcpCallGateForTesting();
  _resetDispatcherGateForTesting();
  registerClubhouseMcpTools();
  setMcpCaller('chat', '/p', {});
  setMcpCaller('dispatcher', '/p', {});
  setMcpCaller('agent', '/p', {});
  setDispatcherChatAgent('chat', true);
  setDispatcherAgent('dispatcher', true);
  // An ordinary agent connected to the Dispatcher, for update_my_card.
  setDispatcherConnectionCheck((id) => id === 'agent');
});

/** Everything the chat is told or reads as guidance, labelled for the failure message. */
function chatFacingText(): Array<[string, string]> {
  return [
    ['chat instructions', DISPATCHER_CHAT_INSTRUCTIONS],
    ...dispatcherSkills('chat').map((s): [string, string] => [`skill ${s.name}`, s.text]),
    ...PROVIDERS.map((p): [string, string] => [`skills list on ${p.id}`, skillsSection('chat', p.conventions)]),
    ...tools('chat').flatMap((t) => descriptions(t).map((d): [string, string] => [`tool ${t.name}`, d])),
    // First run's personality section (#3047), with each preset.
    ...Object.entries(PERSONALITY_PRESET_TEXT).map(([preset, text]): [string, string] => [`personality ${preset}`, personalityInstructions('Rosie', { preset: preset as 'concise', text })]),
    ['a Clubhouse update', defaultChatDelivery({ message: 'Checkout is fixed.' })!.text],
    // The rewrite step's words show in the chat under an agent's name.
    ['rewrite prompt', buildRewritePrompt('webapp-lead', 'Fixed it.')],
  ];
}

describe('what the chat is told', () => {
  it('reads what it should: its instructions, skills and every tool it is offered', () => {
    const labels = chatFacingText().map(([label]) => label);
    for (const name of ['start_work', 'read_memory', 'search_memory', 'list_abilities', 'list_agents']) expect(labels).toContain(`tool ${name}`);
    expect(labels).toContain('skill what-else-can-you-do');
  });

  it('never mentions a second session, the agent that does the work, or how a request reaches it', () => {
    const hits: string[] = [];
    for (const [label, text] of chatFacingText()) {
      text.split('\n').forEach((line, i) => {
        for (const pattern of [NAMES_A_SECOND_SESSION, ...DESCRIBES_THE_SPLIT]) {
          if (pattern.test(line)) hits.push(`${label}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('catches the phrasings it is for', () => {
    for (const text of ['A separate conversation handles it.', 'I handed it off.', 'the hand-off', 'Work happens behind the scenes.', 'my worker', 'call tell_user']) {
      expect(DESCRIBES_THE_SPLIT.some((p) => p.test(text)), text).toBe(true);
    }
    for (const text of ['Ask the agent that owns it.', 'other agents', 'a new conversation', 'Background work counts toward usage.']) {
      expect(DESCRIBES_THE_SPLIT.some((p) => p.test(text)), text).toBe(false);
    }
  });
});

describe('all of the Dispatcher\'s built-in text', () => {
  const texts: Array<[string, string]> = [
    ['chat instructions', DISPATCHER_CHAT_INSTRUCTIONS],
    ['instructions', DISPATCHER_INSTRUCTIONS],
    ...[...dispatcherSkills('chat'), ...dispatcherSkills('work')].map((s): [string, string] => [`skill ${s.name}`, s.text]),
  ];

  it('is plain: no em dashes, and no CLI named', () => {
    for (const [label, text] of texts) {
      expect(text, label).not.toMatch(/—/);
      // Provider-neutral: no product names; the CLI is whichever the user chose.
      expect(text, label).not.toMatch(/\b(?:Claude|Codex|Copilot|CLAUDE\.md|AGENTS\.md)\b/);
    }
  });

  it('names only tools the agent it is for is offered', () => {
    const offered = { chat: new Set(tools('chat').map((t) => t.name)), work: new Set(tools('dispatcher').map((t) => t.name)) };
    // Tools on each wire to a connected agent, which this test registers none of.
    const wireTools = ['send_message', 'wake_agent', 'sleep_agent', 'get_status', 'read_output', 'preview_provider', 'change_provider'];
    const known = (role: 'chat' | 'work', name: string) => offered[role].has(name) || (role === 'work' && wireTools.includes(name));
    const check = (role: 'chat' | 'work', label: string, text: string) => {
      for (const [, name] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        // Arguments and values that look like tool names.
        if (['contact_when', 'needs_user', 'check_in', 'update_my_card'].includes(name)) continue;
        expect(known(role, name), `${label} names ${name}`).toBe(true);
      }
    };
    check('chat', 'chat instructions', DISPATCHER_CHAT_INSTRUCTIONS);
    check('work', 'instructions', DISPATCHER_INSTRUCTIONS);
    for (const s of dispatcherSkills('chat')) check('chat', `skill ${s.name}`, s.text);
    for (const s of dispatcherSkills('work')) check('work', `skill ${s.name}`, s.text);
  });
});

describe('the Dispatcher\'s tool descriptions', () => {
  /** The tools written for the Dispatcher's two agents and the agents connected to it. */
  const DISPATCHER_TOOLS = ['list_agents', 'inspect_helper', 'start_work', 'read_memory', 'list_abilities', 'search_memory', 'tell_user', 'subscribe', 'update_my_card'];
  const DESCRIPTION_BUDGET = 600;
  const ARGUMENT_BUDGET = 200;

  function definition(name: string): McpToolDefinition {
    const found = [...tools('chat'), ...tools('dispatcher'), ...tools('agent')].find((t) => t.name === name);
    if (!found) throw new Error(`${name} is not offered to the Dispatcher or a connected agent`);
    return found;
  }

  it.each(DISPATCHER_TOOLS)('%s stays short and plain', (name) => {
    const def = definition(name);
    expect(def.description.length).toBeLessThanOrEqual(DESCRIPTION_BUDGET);
    const [, ...args] = descriptions(def);
    for (const arg of args) expect(arg.length, arg).toBeLessThanOrEqual(ARGUMENT_BUDGET);
    for (const text of descriptions(def)) {
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(NAMES_A_SECOND_SESSION);
    }
  });

  it('speaks to the agent the same way: second person, no setting that no longer exists', () => {
    for (const name of DISPATCHER_TOOLS) {
      const text = definition(name).description;
      expect(text, name).not.toMatch(/Connect to Dispatcher/);
      expect(text, name).not.toMatch(/\bthe Dispatcher's chat\b/i);
    }
  });
});
