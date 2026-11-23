/**
 * The effective feature contract (#3787): what a surface may offer for a
 * provider, resolved from three separate layers.
 *
 * 1. Static policy, from the provider's descriptor. A declaration is a default
 *    (`supported`, `conditional`, `unsupported`, `unknown`) unless it carries
 *    `policy: 'forbidden'`, which is a Clubhouse decision that nothing a
 *    session reports can override.
 * 2. Negotiated session: the `ChatCapabilities` the driver published in
 *    `session_started`. It decides only the features that map directly onto a
 *    capability field (`SESSION_FEATURE_FIELDS`). Tools, MCP, managed
 *    instructions and skills are never inferred from those booleans.
 * 3. Condition evidence the caller has evaluated (platform, version, auth,
 *    setting). A condition with no evidence stays unresolved, never true or
 *    false by default.
 *
 * The result says which layer decided and why, so a surface can explain an
 * unsupported feature instead of hiding it or assuming parity.
 */

import type { ChatCapabilities } from '../chat/capabilities';

export const PROVIDER_FEATURES = [
  'managed_instructions',
  'skills',
  'mcp',
  'model_switch',
  'effort_switch',
  'permissions',
  'tools',
  'images',
  'questions',
  'steering',
  'cancellation',
  'session_resume',
  'session_history',
  'usage',
] as const;
export type ProviderFeature = (typeof PROVIDER_FEATURES)[number];

export type FeatureSupport = 'supported' | 'conditional' | 'unsupported' | 'unknown';
export type FeatureRuntime = 'chat' | 'terminal' | 'headless';

export interface FeatureCondition {
  kind: 'platform' | 'version' | 'auth' | 'setting';
  /** Stable key the caller supplies evidence for, e.g. `platform:darwin`. */
  id: string;
  /** Shown when the condition is unmet or unresolved. */
  description: string;
}

export type FeatureDeclaration =
  | { support: 'supported'; note?: string }
  | { support: 'unknown'; note?: string }
  | { support: 'unsupported'; reason: string; note?: string }
  /** A Clubhouse decision; a session can't turn it back on. */
  | { support: 'unsupported'; policy: 'forbidden'; reason: string; note?: string }
  | { support: 'conditional'; conditions: readonly FeatureCondition[]; note?: string };

export type FeatureDeclarationMap = Partial<Readonly<Record<ProviderFeature, FeatureDeclaration>>>;

/** `common` applies to every runtime; a runtime's own entry wins over it. */
export interface ProviderFeatureDeclarations {
  common?: FeatureDeclarationMap;
  chat?: FeatureDeclarationMap;
  terminal?: FeatureDeclarationMap;
  headless?: FeatureDeclarationMap;
}

/**
 * The features a negotiated chat session decides, and the capability field
 * that decides each. Only direct mappings belong here.
 */
export const SESSION_FEATURE_FIELDS = {
  steering: (c) => c.steer,
  cancellation: (c) => c.interrupt,
  images: (c) => c.images,
  questions: (c) => c.questions,
  session_resume: (c) => c.resume !== 'none',
  usage: (c) => c.usage !== 'none',
  model_switch: (c) => c.modelSwitch !== 'none',
  effort_switch: (c) => c.effortSwitch !== 'none',
} as const satisfies Partial<Record<ProviderFeature, (c: ChatCapabilities) => boolean>>;
export type SessionFeature = keyof typeof SESSION_FEATURE_FIELDS;

export function isSessionFeature(feature: ProviderFeature): feature is SessionFeature {
  return Object.prototype.hasOwnProperty.call(SESSION_FEATURE_FIELDS, feature);
}

/** Evidence per condition id: met, unmet, or absent (unresolved). */
export type ConditionEvidence = Readonly<Record<string, boolean | undefined>>;

export interface EffectiveFeature {
  feature: ProviderFeature;
  /** `conditional` here means some condition has no evidence yet. */
  support: FeatureSupport;
  /** Which layer decided. `undeclared` means the provider states nothing, so it is unknown. */
  source: 'policy' | 'session' | 'conditions' | 'declared' | 'undeclared';
  reason?: string;
  /** Condition ids with no evidence, when `support` is `conditional`. */
  unresolved?: readonly string[];
  note?: string;
}

export interface ResolveFeatureInput {
  /** The provider's declarations; undefined for a provider Clubhouse has no descriptor for. */
  declarations: ProviderFeatureDeclarations | undefined;
  /** Undefined when the surface doesn't know the runtime; only `common` applies then. */
  runtime?: FeatureRuntime;
  feature: ProviderFeature;
  /** The live session's negotiated capabilities, when there is one. */
  session?: ChatCapabilities;
  evidence?: ConditionEvidence;
}

export function declaredFeature(declarations: ProviderFeatureDeclarations | undefined, runtime: FeatureRuntime | undefined, feature: ProviderFeature): FeatureDeclaration | undefined {
  return (runtime && declarations?.[runtime]?.[feature]) || declarations?.common?.[feature];
}

export function resolveEffectiveFeature(input: ResolveFeatureInput): EffectiveFeature {
  const { feature } = input;
  const declared = declaredFeature(input.declarations, input.runtime, feature);
  const note = declared?.note ? { note: declared.note } : {};
  if (declared?.support === 'unsupported' && 'policy' in declared) {
    return { feature, support: 'unsupported', source: 'policy', reason: declared.reason, ...note };
  }
  if (input.session && isSessionFeature(feature)) {
    return SESSION_FEATURE_FIELDS[feature](input.session)
      ? { feature, support: 'supported', source: 'session', ...note }
      : { feature, support: 'unsupported', source: 'session', reason: 'This session does not offer it.', ...note };
  }
  if (!declared) return { feature, support: 'unknown', source: 'undeclared' };
  if (declared.support !== 'conditional') {
    return { feature, support: declared.support, source: 'declared', ...('reason' in declared && { reason: declared.reason }), ...note };
  }
  const unmet = declared.conditions.find((c) => input.evidence?.[c.id] === false);
  if (unmet) return { feature, support: 'unsupported', source: 'conditions', reason: unmet.description, ...note };
  const unresolved = declared.conditions.filter((c) => input.evidence?.[c.id] !== true).map((c) => c.id);
  if (unresolved.length) return { feature, support: 'conditional', source: 'conditions', unresolved, ...note };
  return { feature, support: 'supported', source: 'conditions', ...note };
}

/** Only `supported` offers the feature; conditional and unknown don't. */
export function isFeatureOffered(effective: EffectiveFeature): boolean {
  return effective.support === 'supported';
}
