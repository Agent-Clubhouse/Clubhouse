/** Closed plan classes, without login/account identifiers. Unknown is never a calibration identity. */
export const QUOTA_CALIBRATION_PLANS = ['max', 'free', 'go', 'plus', 'pro', 'prolite', 'promax', 'team', 'self_serve_business_prolite', 'self_serve_business_usage_based', 'business', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'edu_plus', 'edu_pro', 'sci', 'sci_plus'] as const;
export type QuotaCalibrationPlan = (typeof QUOTA_CALIBRATION_PLANS)[number];
/** Content-free, device-local subscription pressure evidence. Never an exported telemetry attribute. */
export interface QuotaCalibrationIdentity { plan: QuotaCalibrationPlan; generation: string }
export interface PressureBand {
  meanBp: number;
  lowerBp: number;
  upperBp: number;
  samples: number;
  effectiveSamples: number;
  maeBp: number;
  biasBp: number;
  coverageBp: number;
}
export interface PressureDecision {
  version: 1;
  policy: 'aggregate-conformal-v1';
  provider: string;
  plan: QuotaCalibrationPlan;
  planGeneration: string;
  atMs: number;
  asOfMs: number;
  /** Exact cell generations and elapsed buckets for the whole known group; no task text. */
  key: string;
  members: Array<{ decisionId: string; cell: string; startedMs: number }>;
  windows: Array<{ name: 'weekly' | 'fiveHour'; usedBp: number; resetsAtMs: number; band?: PressureBand }>;
}
export interface PressureOutcome {
  atMs: number;
  availableAtMs: number;
  /** One whole-login total, including unknown outside/parent residual; never assigned to a member. */
  attribution: 'subscription_group_with_unknown_residual';
  reason: 'observed' | 'reset' | 'decreased' | 'incomplete' | 'additional_run' | 'restart';
  windows: Array<{ name: 'weekly' | 'fiveHour'; remainingBp: number }>;
}
