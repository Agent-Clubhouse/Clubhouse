import { StandaloneTerminal } from '../features/terminal/StandaloneTerminal';
import { PluginDefinition } from './types';

export const terminalPlugin: PluginDefinition = {
  id: 'terminal',
  label: 'Terminal',
  icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  fullWidth: true,
  MainPanel: StandaloneTerminal,
};
