/**
 * Static provider descriptors (#3787): the app-facing policy and display
 * metadata for each built-in provider, so main and renderer read one table
 * instead of keeping their own lists of provider ids.
 *
 * A descriptor is static policy only. What a running session can do is the
 * driver's negotiated `ChatCapabilities`, and what a surface may offer is the
 * resolution of both (`./features`). Provider-specific behaviour (Codex TOML,
 * Copilot hooks, SDK options) stays with the provider and its driver.
 *
 * Every value here reproduces what the former per-file lists said, exactly;
 * descriptors.test.ts rebuilds each former list and compares. Some values are
 * persisted or sent to peers (helper presets, Auto budget reserves, handoff
 * capacity keys, telemetry enums), so changing one is a schema change, not a
 * table edit.
 */

import type { PermissionLevel } from '../chat/capabilities';
import type { ProviderFeatureDeclarations } from './features';
import { ANTIGRAVITY_PROVIDER_ID } from './antigravity';

/**
 * The built-in providers, in the order surfaces list them. Antigravity is last
 * and experimental: its descriptor exists whether or not the provider is
 * enabled, so saved agents keep their names and glyphs (#3785).
 */
export const BUILTIN_PROVIDER_IDS = ['claude-code', 'codex-cli', 'copilot-cli', ANTIGRAVITY_PROVIDER_ID] as const;
export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

/**
 * The closed `clubhouse.orchestrator` telemetry values, other than `other`.
 * A new provider gets a reviewed addition here; until then it reports `other`.
 */
export const PROVIDER_TELEMETRY_CODES = ['claude-code', 'codex-cli', 'copilot-cli', 'antigravity-cli'] as const;
export type ProviderTelemetryCode = (typeof PROVIDER_TELEMETRY_CODES)[number];

export type ProviderRuntime = 'chat' | 'terminal';

/**
 * How `cli: "auto"` treats a provider (#3803).
 * - `candidate`: Auto may pick it. A provider `allowSetting` can still turn it off.
 * - `opt_in`: skipped unless the person turns its `allowSetting` on. With no setting it is never picked.
 * - `excluded`: never picked; explicit `cli` requests still work.
 */
export type ProviderAutoPolicy = 'candidate' | 'opt_in' | 'excluded';

/**
 * Whether Clubhouse can read the provider's plan quota without spending tokens.
 * `unknown` providers rank behind every provider with a reading, including low
 * and temporarily unmeasured ones (`last_resort`, #3279). Temporarily unreadable
 * quota on a `reader` provider stays its own case (`unmeasured`).
 */
export type ProviderQuotaKind = 'reader' | 'unknown';

/** Mascot art keys; the renderer owns the drawings. A provider without one gets the generic robot. */
export type ProviderMascot = 'claude' | 'codex' | 'copilot';

/** Badge colors from the `--ctp-badge-*` theme variables. */
export type ProviderBadgeColor = 'orange' | 'teal' | 'blue' | 'indigo';

export interface ProviderPresetCell {
  model: string;
  /** Null passes no level, so the CLI picks. */
  effort: string | null;
}

export interface ProviderDescriptor {
  id: string;
  /** Badges, glyph tooltips and agent labels when the provider isn't registered. */
  displayName: string;
  /** Helper settings section names. */
  shortName: string;
  /** Chat version notices ("Copilot CLI 1.0 isn't supported"). */
  cliLabel: string;
  /** The command a person runs, shown in a sleeping agent's resume hint. */
  command: string;
  glyph: string;
  badgeColor: ProviderBadgeColor;
  mascot?: ProviderMascot;
  /** `other` until a reviewed addition to `PROVIDER_TELEMETRY_CODES`. */
  telemetryCode: ProviderTelemetryCode | 'other';
  install: { docsUrl: string };
  /**
   * The Access levels each runtime can start at. Chat follows each driver's
   * mapping; a terminal agent gets only the levels its CLI has a start flag for.
   */
  access: Readonly<Record<ProviderRuntime, readonly PermissionLevel[]>>;
  helperRouting: {
    /** Built-in Auto presets per difficulty; absent means the provider has no preset mapping. */
    presets?: Readonly<Record<'easy' | 'medium' | 'hard', ProviderPresetCell>>;
    auto: ProviderAutoPolicy;
    quota: ProviderQuotaKind;
    /** A persisted app setting that allows this provider for Auto, read as on unless saved off. */
    allowSetting?: 'copilotAuto';
    /** Has an Auto budget reserve in the persisted budget policy. */
    budgetReserve: boolean;
  };
  /** Reported in handoff capacity. The key set is a peer wire contract. */
  capacityTracked: boolean;
  /** The variable that moves the CLI's state folder, and the folder's default under home. */
  stateDir?: { env: string; fallback: string };
  /** Static feature policy; see `./features`. */
  features: ProviderFeatureDeclarations;
}

const ALL_LEVELS: readonly PermissionLevel[] = ['plan', 'ask', 'auto_edit', 'auto', 'full_access'];

const CLAUDE_CODE = {
  id: 'claude-code',
  displayName: 'Claude Code',
  shortName: 'Claude Code',
  cliLabel: 'Claude Code',
  command: 'claude',
  glyph: 'C',
  badgeColor: 'orange',
  mascot: 'claude',
  telemetryCode: 'claude-code',
  install: { docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup' },
  access: { chat: ALL_LEVELS, terminal: ALL_LEVELS },
  helperRouting: {
    presets: {
      easy: { model: 'haiku', effort: 'low' },
      medium: { model: 'sonnet', effort: 'medium' },
      hard: { model: 'opus', effort: 'high' },
    },
    auto: 'candidate',
    quota: 'reader',
    budgetReserve: true,
  },
  capacityTracked: true,
  stateDir: { env: 'CLAUDE_CONFIG_DIR', fallback: '.claude' },
  features: {
    common: { session_history: { support: 'supported' } },
    chat: {
      steering: { support: 'supported' },
      cancellation: { support: 'supported' },
      images: { support: 'supported' },
      questions: { support: 'supported' },
      session_resume: { support: 'supported' },
      usage: { support: 'supported', note: 'Cost and tokens.' },
      model_switch: { support: 'supported', note: 'Applies live.' },
      effort_switch: { support: 'supported', note: 'Applies live.' },
    },
  },
} as const satisfies ProviderDescriptor;

const CODEX_CLI = {
  id: 'codex-cli',
  displayName: 'Codex',
  shortName: 'Codex',
  cliLabel: 'Codex',
  command: 'codex',
  glyph: 'X',
  badgeColor: 'teal',
  mascot: 'codex',
  telemetryCode: 'codex-cli',
  install: { docsUrl: 'https://github.com/openai/codex' },
  // Codex has no plan or accept-edits start mode in the terminal.
  access: { chat: ALL_LEVELS, terminal: ['ask', 'auto', 'full_access'] },
  helperRouting: {
    presets: {
      easy: { model: 'gpt-6-luna', effort: 'low' },
      medium: { model: 'gpt-6.1-terra', effort: 'medium' },
      hard: { model: 'gpt-6.1-sol', effort: 'high' },
    },
    auto: 'candidate',
    quota: 'reader',
    budgetReserve: true,
  },
  capacityTracked: true,
  stateDir: { env: 'CODEX_HOME', fallback: '.codex' },
  features: {
    common: { session_history: { support: 'supported' } },
    chat: {
      steering: { support: 'supported' },
      cancellation: { support: 'supported' },
      images: { support: 'supported' },
      questions: { support: 'unsupported', reason: 'The Codex app-server driver does not surface structured questions.' },
      session_resume: { support: 'supported' },
      usage: { support: 'supported', note: 'Tokens only.' },
      model_switch: { support: 'supported', note: 'Applies from the next message.' },
      effort_switch: { support: 'supported', note: 'Applies from the next message.' },
    },
  },
} as const satisfies ProviderDescriptor;

const COPILOT_CLI = {
  id: 'copilot-cli',
  displayName: 'GitHub Copilot',
  shortName: 'Copilot',
  cliLabel: 'Copilot CLI',
  command: 'copilot',
  glyph: 'G',
  badgeColor: 'blue',
  mascot: 'copilot',
  telemetryCode: 'copilot-cli',
  install: { docsUrl: 'https://github.com/github/copilot-cli' },
  // No Auto level: Copilot's free-agent flags (--yolo --autopilot) allow
  // everything, and its autopilot keeps going on its own.
  access: { chat: ['plan', 'ask', 'auto_edit', 'full_access'], terminal: ['ask', 'full_access'] },
  helperRouting: {
    // Copilot's own ids for the Claude family, at the same levels as Claude Code's.
    // Its live list (the SDK's models.list) reports these levels for them; its
    // fallback list reports none, so there a cell shows as unverified.
    presets: {
      easy: { model: 'claude-haiku-5.5', effort: 'low' },
      medium: { model: 'claude-sonnet-5.5', effort: 'medium' },
      hard: { model: 'claude-opus-5.5', effort: 'high' },
    },
    auto: 'candidate',
    // No plan-quota reader, so it ranks last (#3279).
    quota: 'unknown',
    allowSetting: 'copilotAuto',
    budgetReserve: false,
  },
  capacityTracked: true,
  stateDir: { env: 'COPILOT_HOME', fallback: '.copilot' },
  features: {
    common: { session_history: { support: 'supported' } },
    chat: {
      steering: { support: 'supported' },
      cancellation: { support: 'supported' },
      images: { support: 'supported' },
      questions: { support: 'supported' },
      session_resume: { support: 'supported' },
      usage: { support: 'supported', note: 'Tokens only; credits are not reported.' },
      model_switch: { support: 'supported', note: 'Applies live.' },
      effort_switch: { support: 'supported', note: 'Applies live.' },
    },
  },
} as const satisfies ProviderDescriptor;

const ANTIGRAVITY_DOCS = 'https://antigravity.google/docs';

/**
 * Antigravity CLI (#3785): experimental, hidden unless its flag and provider
 * toggle are on. Values are deliberately conservative:
 * - Access has no Auto level. `--mode auto` needs the terminal sandbox, a
 *   minimum version per platform and a non-business account, none of which
 *   Clubhouse has evidence for yet (#3791).
 * - No presets, so Auto never considers it; the declared policy is `opt_in`
 *   (#3803), off unless a later change adds presets and an allow setting.
 * - Telemetry reports `other` until the enum addition is reviewed (#3800).
 * - Not capacity-tracked: peers validate the exact capacity key set, so adding
 *   a key needs a compatible wire change first (#3799).
 * - No state folder: Antigravity documents no config-dir override.
 */
const ANTIGRAVITY_CLI = {
  id: ANTIGRAVITY_PROVIDER_ID,
  displayName: 'Antigravity CLI',
  shortName: 'Antigravity',
  cliLabel: 'Antigravity CLI',
  command: 'agy',
  glyph: 'A',
  badgeColor: 'indigo',
  telemetryCode: 'antigravity-cli',
  install: { docsUrl: `${ANTIGRAVITY_DOCS}/getting-started/` },
  access: {
    chat: ['plan', 'ask', 'auto_edit', 'full_access'],
    terminal: ['plan', 'ask', 'auto_edit', 'full_access'],
  },
  helperRouting: {
    auto: 'opt_in',
    // No token-free quota read is documented (`/usage` is interactive).
    quota: 'unknown',
    budgetReserve: false,
  },
  capacityTracked: false,
  features: {
    common: {
      managed_instructions: {
        support: 'conditional',
        conditions: [{ kind: 'setting', id: 'antigravity:instructions_within_limit', description: 'AGENTS.md, including your own text, must be 24,000 bytes or less.' }],
        note: 'Your global Antigravity rules also count toward its rules budget.',
      },
      mcp: {
        support: 'conditional',
        conditions: [{ kind: 'setting', id: 'antigravity:bridge_authenticated', description: 'The Clubhouse MCP counts as connected only after it authenticates for this launch.' }],
      },
      session_history: { support: 'unsupported', reason: 'Antigravity does not document its transcript format, so Clubhouse does not read it.' },
    },
    chat: {
      cancellation: { support: 'supported' },
      model_switch: { support: 'unknown', note: 'Models are whatever the session offers.' },
      effort_switch: { support: 'unknown', note: 'Thinking level, when the session offers it.' },
      steering: { support: 'unknown', note: 'Documented; settlement on the real server is unverified.' },
    },
    terminal: {
      session_resume: { support: 'supported', note: 'By conversation id from hooks, else the most recent in the folder.' },
    },
  },
} as const satisfies ProviderDescriptor;

export const PROVIDER_DESCRIPTORS = {
  'claude-code': CLAUDE_CODE,
  'codex-cli': CODEX_CLI,
  'copilot-cli': COPILOT_CLI,
  [ANTIGRAVITY_PROVIDER_ID]: ANTIGRAVITY_CLI,
} as const satisfies Readonly<Record<BuiltinProviderId, ProviderDescriptor>>;

type Descriptors = typeof PROVIDER_DESCRIPTORS;
type IdsWhere<P> = { [K in BuiltinProviderId]: Descriptors[K] extends P ? K : never }[BuiltinProviderId];

/** Providers with a built-in Auto preset mapping. */
export type PresetProviderId = IdsWhere<{ helperRouting: { presets: object } }>;
/** Providers `cli: "auto"` may consider: candidates and opt-ins. */
export type AutoProviderId = IdsWhere<{ helperRouting: { auto: 'candidate' | 'opt_in' } }>;
/** Providers with an Auto budget reserve. */
export type BudgetReserveProviderId = IdsWhere<{ helperRouting: { budgetReserve: true } }>;
/** Providers reported in handoff capacity. */
export type CapacityProviderId = IdsWhere<{ capacityTracked: true }>;

/**
 * The order handoff capacity lists its providers in, as sent to peers before
 * descriptors existed. Peers check the key set only; the order is kept so the
 * JSON is byte-for-byte the same. Every capacity-tracked provider must be here.
 */
export const CAPACITY_WIRE_ORDER: readonly CapacityProviderId[] = ['claude-code', 'copilot-cli', 'codex-cli'];

export function isBuiltinProviderId(id: unknown): id is BuiltinProviderId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_DESCRIPTORS, id);
}

/** The descriptor for a built-in provider, or undefined for any other id. */
export function providerDescriptor(id: string | null | undefined): ProviderDescriptor | undefined {
  return isBuiltinProviderId(id) ? PROVIDER_DESCRIPTORS[id] : undefined;
}

/** Built-in descriptors in `BUILTIN_PROVIDER_IDS` order. */
export function providerDescriptors(): readonly ProviderDescriptor[] {
  return BUILTIN_PROVIDER_IDS.map((id) => PROVIDER_DESCRIPTORS[id]);
}

/** Built-in ids whose descriptor matches, in `BUILTIN_PROVIDER_IDS` order. */
export function providerIdsWhere<T extends BuiltinProviderId = BuiltinProviderId>(test: (d: ProviderDescriptor) => boolean): readonly T[] {
  return BUILTIN_PROVIDER_IDS.filter((id) => test(PROVIDER_DESCRIPTORS[id])) as T[];
}

/** The closed telemetry value for a provider id; anything not reviewed into the enum is `other`. */
export function providerTelemetryCode(id: string | null | undefined): ProviderTelemetryCode | 'other' {
  return providerDescriptor(id)?.telemetryCode ?? 'other';
}
