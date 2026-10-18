/**
 * The host stores, components and events Review uses, in one place so the
 * builtin import boundary (eslint.config.mjs) allowlists a single file. Review
 * reaches past the plugin API for the 18px chrome avatar, the shared Toggle,
 * Button and PopupMenu, the new chrome's selection and New agent dialog, focusing
 * the terminal on Return, and waking with a resumed session and a prompt, which
 * `api.agents.resume` doesn't offer, and the transcript's Markdown for a sleeping
 * agent's last replies. The status vocabulary (StatusDot, DOT_LABEL,
 * agentDot) comes from here too; formatDuration is imported directly.
 */
export { Toggle } from '../../../components/Toggle';
export { Button } from '../../../components/Button';
export { PopupMenu, type MenuItem } from '../../../components/PopupMenu';
export { AgentAvatar } from '../../../features/agents/AgentAvatar';
export { useAgentStore } from '../../../stores/agentStore';
export { useProjectStore } from '../../../stores/projectStore';
export { useAnnexClientStore } from '../../../stores/annexClientStore';
export { useRemoteProjectStore, isRemoteAgentId, parseNamespacedId } from '../../../stores/remoteProjectStore';
export { useChromeStore } from '../../../chrome/chromeStore';
export { useChromeFlagStore } from '../../../chrome/chromeFlag';
export { openNewAgentOrDialog } from '../../../chrome/startPage';
export { FOCUS_ACTIVE_TERMINAL_EVENT } from '../../../features/agents/AgentTerminal';
export { StatusDot, DOT_LABEL, agentDot, type AgentDot } from '../../../features/agents/agent-status';
export { Markdown } from '../../../features/agents/chat/MessageBlocks';
