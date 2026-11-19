/** Bounded display evidence only. No instructions, MCP definitions, env values, paths or grants. */
export const REMOTE_SETTINGS_MAX_BYTES = 64 * 1024;
export interface RemoteAgentSettings {
  version: 1;
  agentId: string;
  readOnly: true;
  provider: string;
  model: string;
  /** The host's next-start runtime; live runtime comes from chat/snapshot evidence. */
  runtime: 'chat' | 'terminal';
  access: string;
  executionPolicy: string;
  autoSleep: string | null;
  context: string | null;
  setup: {
    state: 'ok' | 'error';
    managed: boolean;
    template: string | null;
    instructions: string;
    skills: string[] | null;
    mcps: string[] | null;
    updatedBy?: string;
    updatedAt?: string;
    waiting?: boolean;
  };
}

/** Treat malformed/new contracts as unavailable, never as local defaults. */
export function isRemoteAgentSettings(value: unknown, agentId: string): value is RemoteAgentSettings {
  if (!value || typeof value !== 'object') return false;
  const v = value as RemoteAgentSettings;
  const text = (x: unknown) => typeof x === 'string' && x.length <= 1024;
  const nullable = (x: unknown) => x === null || text(x);
  const names = (x: unknown) => x === null || Array.isArray(x) && x.length <= 100 && x.every(text);
  return v.version === 1 && v.agentId === agentId && v.readOnly === true
    && [v.provider, v.model, v.access, v.executionPolicy].every(text)
    && ['chat', 'terminal'].includes(v.runtime) && nullable(v.autoSleep) && nullable(v.context)
    && !!v.setup && ['ok', 'error'].includes(v.setup.state) && typeof v.setup.managed === 'boolean'
    && nullable(v.setup.template) && text(v.setup.instructions) && names(v.setup.skills) && names(v.setup.mcps)
    && (v.setup.updatedBy === undefined || text(v.setup.updatedBy)) && (v.setup.updatedAt === undefined || text(v.setup.updatedAt))
    && (v.setup.waiting === undefined || typeof v.setup.waiting === 'boolean');
}
