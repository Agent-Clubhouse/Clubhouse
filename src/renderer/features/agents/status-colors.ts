import { DOT_COLOR } from './agent-status';

/**
 * Avatar ring colors by `agent.status` and hook state, in the shared status
 * palette (agent-status.tsx). Prefer `statusRingColor(agent, detailed)`, which
 * also tells a working agent from one that is done with its turn.
 */
export const STATUS_RING_COLORS: Record<string, string> = {
  running: DOT_COLOR.working,
  sleeping: DOT_COLOR.sleeping,
  waking: DOT_COLOR.starting,
  creating: DOT_COLOR.starting,
  error: DOT_COLOR.error,
  needs_permission: DOT_COLOR.needs,
  tool_error: DOT_COLOR.error,
};
