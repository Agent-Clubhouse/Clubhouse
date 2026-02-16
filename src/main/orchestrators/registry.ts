import { OrchestratorId, OrchestratorProvider } from './types';
import { ClaudeCodeProvider } from './claude-code-provider';
import { CopilotCliProvider } from './copilot-cli-provider';
import { OpenCodeProvider } from './opencode-provider';

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

/** Register all built-in orchestrator providers. Call once at startup. */
export function registerBuiltinProviders(): void {
  registerProvider(new ClaudeCodeProvider());
  registerProvider(new CopilotCliProvider());
  registerProvider(new OpenCodeProvider());
}
