/** Passive next-start provider evidence from the already admitted selected target. */
import * as path from 'path';
import { getProvider, type OrchestratorProvider } from '../orchestrators';
import { DEFAULT_ORCHESTRATOR } from './agent-registry';
import type { AgentConfigTarget } from './agent-config-reader';
import { peekMetadataFileForDisplaySync } from './settings-store';
import { DISPLAY_SETTINGS_MAX_BYTES, type DisplayValue, type DisplayReceipt } from './display-settings';

export interface DisplayProviderSnapshot { selection: DisplayValue<string>; provider?: OrchestratorProvider; receipt: DisplayReceipt; matchesTarget(target: AgentConfigTarget): boolean }

/** No project inventory scan, generic SettingsStore load, fallback backup, shell or provider probe. */
export function captureDisplayProvider(target: AgentConfigTarget): DisplayProviderSnapshot {
  // Keep only the selected scalar evidence, not the admitted agent's config/env.
  const override: unknown = target.agent.orchestrator, registered: unknown = target.project.orchestrator, folder = target.project.path;
  const agentId = target.agent.id, projectId = target.project.id;
  const read = (): DisplayValue<string> => {
    const input = (field: string, source: 'agent' | 'primary') => [{ field, source, observedAt: Date.now() }];
    if (override !== undefined && override !== '') return typeof override === 'string' && override.length <= 1024
      ? { state: 'ok', value: override, inputs: input('Agent CLI choice', 'agent') } : { state: 'unavailable', inputs: input('Agent CLI choice', 'agent') };
    if (registered !== undefined && registered !== '' && (typeof registered !== 'string' || registered.length > 1024)) return { state: 'unavailable', inputs: input('Registered project CLI', 'primary') };
    // The launch resolver explicitly ignores removed project providers. A
    // newly registered replacement changes this selection and invalidates it.
    if (typeof registered === 'string' && registered && getProvider(registered)) return { state: 'ok', value: registered, inputs: input('Registered project CLI', 'primary') };
    const raw = peekMetadataFileForDisplaySync(path.join(folder, '.clubhouse', 'settings.json'), DISPLAY_SETTINGS_MAX_BYTES);
    const inputs = input('Project legacy CLI or host default', 'primary');
    if (raw === 'unreadable') return { state: 'unavailable', inputs };
    const value = raw === 'missing' ? undefined : raw.orchestrator;
    if (value !== undefined && (typeof value !== 'string' || value.length > 1024)) return { state: 'unavailable', inputs };
    return { state: 'ok', value: typeof value === 'string' && value ? value : DEFAULT_ORCHESTRATOR, inputs };
  };
  const selection = read(), provider = selection.state === 'ok' ? getProvider(selection.value) : undefined;
  const signature = (choice: DisplayValue<string>, selected: OrchestratorProvider | undefined) => JSON.stringify({ state: choice.state,
    id: choice.state === 'ok' ? choice.value : undefined, sources: choice.inputs.map(({ field, source }) => ({ field, source })),
    // Only display/capability/file-name facts used by these readers, never raw
    // provider objects, launch configuration, profiles or environment values.
    label: selected?.displayName, permissions: selected?.getCapabilities?.().permissions,
    configDir: selected?.conventions?.configDir, localInstructionsFile: selected?.conventions?.localInstructionsFile,
    legacyInstructionsFile: selected?.conventions?.legacyInstructionsFile, mcpConfigFile: selected?.conventions?.mcpConfigFile });
  const admitted = signature(selection, provider);
  const receipt: DisplayReceipt = { current: () => {
    try {
      const now = read(), current = now.state === 'ok' ? getProvider(now.value) : undefined;
      return current === provider && signature(now, current) === admitted;
    } catch { return false; }
  } };
  return { selection, provider, receipt, matchesTarget: (candidate) => candidate.agent.id === agentId && candidate.project.id === projectId
    && candidate.project.path === folder && candidate.agent.orchestrator === override && candidate.project.orchestrator === registered };
}
