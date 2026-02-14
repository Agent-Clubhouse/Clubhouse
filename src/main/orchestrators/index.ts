export type { OrchestratorId, OrchestratorProvider, OrchestratorConventions, SpawnOpts, NormalizedHookEvent } from './types';
export { ClaudeCodeProvider } from './claude-code-provider';
export { CopilotCliProvider } from './copilot-cli-provider';
export { registerProvider, getProvider, getAllProviders, registerBuiltinProviders } from './registry';
