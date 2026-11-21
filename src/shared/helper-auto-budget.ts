/** App-wide policy for the provider's shared local subscription, never a router-local quota bucket. */
export const AUTO_RESERVE_PROVIDERS = ['claude-code', 'codex-cli'] as const;
export type AutoReserveProvider = (typeof AUTO_RESERVE_PROVIDERS)[number];
export type AutoReserves = Record<AutoReserveProvider, number>;

export interface AutoBudgetPolicy {
  version: 1;
  enabled: boolean;
  /** Whole percentage points retained in every applicable reported window. */
  reserves: AutoReserves;
}

/** A present unreadable schema is fail-closed, never silently migrated to legacy. */
export type AutoBudgetSetting = AutoBudgetPolicy | 'invalid';
export type AutoBudgetRules = { mode: 'invalid' } | { mode: 'reset_aware' | 'reserve_only'; reserves: AutoReserves };

export function isAutoReserveProvider(value: string): value is AutoReserveProvider {
  return (AUTO_RESERVE_PROVIDERS as readonly string[]).includes(value);
}

export function defaultAutoBudgetPolicy(): AutoBudgetPolicy {
  return { version: 1, enabled: true, reserves: { 'claude-code': 10, 'codex-cli': 10 } };
}

export function isRetainedPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

/** Closed schema: this version has no relaxation, expressions or extra provider keys. */
export function isAutoBudgetPolicy(value: unknown): value is AutoBudgetPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (p.version !== 1 || typeof p.enabled !== 'boolean' || Object.keys(p).some((k) => !['version', 'enabled', 'reserves'].includes(k))) return false;
  if (!p.reserves || typeof p.reserves !== 'object' || Array.isArray(p.reserves)) return false;
  const reserves = p.reserves as Record<string, unknown>;
  return Object.keys(reserves).length === AUTO_RESERVE_PROVIDERS.length
    && AUTO_RESERVE_PROVIDERS.every((id) => isRetainedPercent(reserves[id]));
}

export function readAutoBudgetSetting(value: unknown): AutoBudgetSetting | undefined {
  if (value === undefined) return undefined;
  if (!isAutoBudgetPolicy(value)) return 'invalid';
  return { version: 1, enabled: value.enabled, reserves: { ...value.reserves } };
}

export interface AutoBudgetQuota {
  asOfMs?: number;
  complete: boolean;
  windows: Array<{
    name: 'weekly' | 'fiveHour' | 'model' | 'other';
    usedBp?: number;
    resetsAtMs?: number;
    limitReached?: boolean;
  }>;
}

/** Immutable decision-time explanation; no rate is fabricated when history is absent. */
export interface AutoBudgetReceipt {
  mode: AutoBudgetRules['mode'];
  retainedPercent?: number;
  ceilingBp?: number;
  usableBp?: number;
  resetsAtMs?: number;
  urgency: 'none' | 'within_48h' | 'within_24h';
  forecast: 'unavailable' | 'qualified';
  block?: 'invalid_policy' | 'incomplete_quota' | 'observed_reserve' | 'predicted_reserve';
}
