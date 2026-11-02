/**
 * The audit record of settings changes (#2671), one JSON line per change or
 * refusal, in `settings-audit.jsonl` under the Clubhouse base dir. So far it
 * covers helper presets and orchestration policy; docs/helper-auto-routing.md
 * lists the writers still to come.
 *
 * Rows hold values that are enums, booleans, whole numbers or ids checked before
 * they got here, never names, commands or free text. Rows use ids, not paths.
 */

import { createAuditLog } from './bounded-audit-log';

export type SettingsAuditSurface = 'ui' | 'mcp' | 'mobile' | 'dispatcher' | 'persona' | 'system';
export type SettingsAuditValue = boolean | number | string | null;

export interface SettingsAuditRow {
  surface: SettingsAuditSurface;
  /** The agent that asked, when an agent did. */
  actorId?: string;
  scope: 'app' | 'project' | 'agent';
  /** The agent the setting is on, for agent scope. */
  targetId?: string;
  key: string;
  before?: SettingsAuditValue;
  after?: SettingsAuditValue;
  outcome: 'ok' | 'refused' | 'error';
  code?: string;
}

export const MAX_SETTINGS_AUDIT_READ = 50;

const log = createAuditLog<SettingsAuditRow>('settings-audit.jsonl', (row) => ({ key: row.key }), MAX_SETTINGS_AUDIT_READ);

export const settingsAuditPath = log.path;
export const appendSettingsAudit = log.append;
export const readSettingsAudit = log.read;
export const _resetSettingsAuditForTesting = log.reset;
