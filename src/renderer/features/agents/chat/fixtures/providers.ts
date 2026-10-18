/**
 * Per-provider facts the fixtures differ by: driver, capability record, model
 * and the shapes each protocol gives us after normalization. Values follow the
 * 2026-10-16 probes in docs/structured-chat-research.md §3 and §5.
 */

import { MINIMAL_CHAT_CAPABILITIES } from '../../../../../shared/chat';
import type { ChatCapabilities, ChatDriverId, PermissionOption, ToolCallContent, UsageLimit } from '../../../../../shared/chat';

export type FixtureProvider = 'claude' | 'codex' | 'copilot';
export const FIXTURE_PROVIDERS: readonly FixtureProvider[] = ['claude', 'codex', 'copilot'];

export interface ProviderFixtureProfile {
  driver: ChatDriverId;
  provider: string;
  model: string;
  effort?: string;
  cliVersion: string;
  capabilities: ChatCapabilities;
  /** Options for an `npm install` approval, in the provider's own wording. */
  installOptions: PermissionOption[];
  installTitle: string;
  installDescription?: string;
  /** The diff content a file edit arrives with. */
  editContent: ToolCallContent;
  limits?: UsageLimit[];
}

const EDIT_OLD = [
  '<div className="agent-row" onClick={select}>',
  '  <div className="flex flex-col gap-1.5 px-3 py-3.5">',
  '    <AgentChips agent={agent} />',
  '    <span className="truncate">{agent.name}</span>',
].join('\n');
const EDIT_NEW = [
  '<div className="agent-row" onClick={select}>',
  '  <div className="flex h-[30px] items-center gap-2 px-2.5">',
  '    <StatusDot state={agent.status} />',
  '    <AgentAvatar agent={agent} size="xs" />',
  '    <span className="truncate">{agent.name}</span>',
].join('\n');
const EDIT_PATH = 'src/renderer/features/agents/AgentListItem.tsx';
const EDIT_UNIFIED = [
  `--- a/${EDIT_PATH}`,
  `+++ b/${EDIT_PATH}`,
  '@@ -88,4 +88,5 @@',
  ' <div className="agent-row" onClick={select}>',
  '-  <div className="flex flex-col gap-1.5 px-3 py-3.5">',
  '-    <AgentChips agent={agent} />',
  '+  <div className="flex h-[30px] items-center gap-2 px-2.5">',
  '+    <StatusDot state={agent.status} />',
  '+    <AgentAvatar agent={agent} size="xs" />',
  '     <span className="truncate">{agent.name}</span>',
].join('\n');

const HOUR = 60 * 60 * 1000;
const RESET_BASE = Date.UTC(2026, 9, 16, 20, 0, 0);

export const PROFILES: Record<FixtureProvider, ProviderFixtureProfile> = {
  claude: {
    driver: 'claude_agent_sdk',
    provider: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'high',
    cliVersion: '2.1.300',
    capabilities: {
      ...MINIMAL_CHAT_CAPABILITIES,
      steer: true,
      queue: 'native',
      interrupt: true,
      resume: 'native',
      planApproval: true,
      questions: true,
      subagents: 'full',
      usage: 'cost',
      limits: true,
      images: true,
      slashCommands: true,
      modelSwitch: 'live',
      effortSwitch: 'live',
      liveLevels: ['plan', 'ask', 'auto_edit', 'auto', 'full_access'],
      login: 'terminal',
      systemPrompt: true,
      permissionExtras: { denyMessage: true, updatedInput: true },
    },
    installTitle: 'Run npm install zod@4 --save',
    installDescription: 'Adds zod to package.json and package-lock.json.',
    installOptions: [
      // Ids and labels as ClaudeChatDriver builds them (claudePermissionOptions).
      { optionId: 'allow', kind: 'allow_once', label: 'Allow' },
      { optionId: 'allow_always', kind: 'allow_always', label: "Allow and don't ask again", scope: 'Bash(npm install:*)' },
      { optionId: 'deny', kind: 'reject_once', label: 'Deny' },
    ],
    editContent: { type: 'diff', path: EDIT_PATH, oldText: EDIT_OLD, newText: EDIT_NEW },
    limits: [
      { window: '5h', utilization: 0.23, status: 'ok', resetsAt: RESET_BASE },
      { window: 'week', utilization: 0.41, status: 'ok', resetsAt: RESET_BASE + 72 * HOUR },
    ],
  },
  codex: {
    driver: 'codex_app_server',
    provider: 'codex-cli',
    model: 'gpt-6.1-sol',
    effort: 'high',
    cliVersion: '0.159.3',
    capabilities: {
      ...MINIMAL_CHAT_CAPABILITIES,
      steer: true,
      queue: 'client',
      interrupt: true,
      resume: 'native',
      planApproval: false,
      questions: true,
      subagents: 'full',
      usage: 'tokens',
      limits: true,
      images: true,
      slashCommands: false,
      modelSwitch: 'per_turn',
      effortSwitch: 'per_turn',
      liveLevels: ['plan', 'ask', 'auto_edit', 'auto', 'full_access'],
      login: 'api',
      systemPrompt: true,
    },
    installTitle: 'Run npm install zod@4 --save',
    installDescription: 'Network access is needed to install the zod package. Sandbox: workspace-write, network off.',
    installOptions: [
      { optionId: 'accept', kind: 'allow_once', label: 'Accept' },
      { optionId: 'acceptForSession', kind: 'allow_session', label: 'Accept for this session' },
      { optionId: 'acceptWithExecpolicyAmendment', kind: 'allow_always', label: 'Always allow commands starting with npm install', scope: 'npm install' },
      { optionId: 'decline', kind: 'reject_once', label: 'Decline' },
      { optionId: 'cancel', kind: 'cancel_turn', label: 'Decline and stop the turn' },
    ],
    editContent: { type: 'diff', path: EDIT_PATH, unifiedDiff: EDIT_UNIFIED },
    limits: [
      { window: '5h', utilization: 0.31, resetsAt: RESET_BASE },
      { window: 'week', utilization: 0.12, resetsAt: RESET_BASE + 96 * HOUR },
    ],
  },
  copilot: {
    driver: 'copilot_acp',
    provider: 'copilot-cli',
    model: 'claude-sonnet-5.5',
    effort: 'medium',
    cliVersion: '1.0.92',
    // As the copilot_acp driver reports them (acp-chat-mapper.ts): no Auto level
    // over ACP, unverified subagent ids claimed as none, per-turn token totals.
    capabilities: {
      ...MINIMAL_CHAT_CAPABILITIES,
      steer: false,
      queue: 'client',
      interrupt: true,
      resume: 'replay',
      planApproval: false,
      questions: false,
      subagents: 'none',
      usage: 'tokens',
      limits: false,
      images: true,
      slashCommands: true,
      modelSwitch: 'live',
      liveLevels: ['plan', 'ask', 'full_access'],
      login: 'terminal',
      systemPrompt: false,
    },
    installTitle: 'Run shell command: npm install zod@4 --save',
    installOptions: [
      { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
      { optionId: 'allow_always', kind: 'allow_always', label: 'Always allow' },
      { optionId: 'reject_once', kind: 'reject_once', label: 'Reject' },
    ],
    editContent: { type: 'diff', path: EDIT_PATH, oldText: EDIT_OLD, newText: EDIT_NEW },
  },
};
