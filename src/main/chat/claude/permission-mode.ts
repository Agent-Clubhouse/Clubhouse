import type { PermissionLevel } from '../../../shared/chat/capabilities';

/**
 * Claude's native permission mode → Clubhouse level. `dontAsk` (deny anything
 * not pre-approved), the CLI's `manual` alias and anything unknown sit on
 * "ask". Shared by the chat driver and the terminal hook parser (#2228); no
 * SDK imports, so the provider can load it.
 */
export function levelFromClaudeMode(mode: string): PermissionLevel {
  switch (mode) {
    case 'plan': return 'plan';
    case 'acceptEdits': return 'auto_edit';
    case 'auto': return 'auto';
    case 'bypassPermissions': return 'full_access';
    default: return 'ask';
  }
}
