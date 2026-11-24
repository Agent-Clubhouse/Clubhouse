import { OrchestratorId, OrchestratorProvider } from './types';
import { ClaudeCodeProvider } from './claude-code-provider';
import { CopilotCliProvider } from './copilot-cli-provider';
import { CodexCliProvider } from './codex-cli-provider';
import { AntigravityCliProvider } from './antigravity-cli-provider';
const providers = new Map<OrchestratorId, OrchestratorProvider>();

export function registerProvider(provider: OrchestratorProvider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: OrchestratorId): OrchestratorProvider | undefined {
  return providers.get(id);
}

export function getAllProviders(): OrchestratorProvider[] {
  return Array.from(providers.values());
}

export interface BuiltinProviderOptions {
  /**
   * Register the experimental Antigravity CLI provider (#3785). Read from its
   * experimental flag at startup; off by default. Registered last, so it is
   * never the first-enabled default.
   */
  antigravity?: boolean;
}

/** Register all built-in orchestrator providers. Call once at startup. */
export function registerBuiltinProviders(options: BuiltinProviderOptions = {}): void {
  registerProvider(new ClaudeCodeProvider());
  registerProvider(new CopilotCliProvider());
  registerProvider(new CodexCliProvider());
  if (options.antigravity) registerProvider(new AntigravityCliProvider());
}
