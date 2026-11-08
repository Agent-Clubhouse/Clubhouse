/**
 * Workshop plugins retired for v1.0 (#2757, #2756). They live in the Workshop
 * repo, not here, so retiring them means Clubhouse refuses to load or install
 * them by id. Nothing is uninstalled and no data is deleted: a person who had
 * one keeps its data on disk, can see and export it from Settings, and is told
 * what replaces it.
 */
export interface RetiredPlugin {
  /** Display name, for notices. */
  name: string;
  /** What Clubhouse offers instead, and what it doesn't. One or two sentences. */
  replacement: string;
}

export const RETIRED_PLUGINS: Readonly<Record<string, RetiredPlugin>> = {
  lounge: {
    name: 'Lounge',
    replacement:
      'The sidebar project tree and Needs you replace it. Custom circles, cross-project grouping, tags and ordering have no replacement.',
  },
  kanboss: {
    name: 'KanBoss',
    replacement: 'There is no built-in board. Your boards and cards are kept in each project\'s .clubhouse folder.',
  },
  'bug-report': {
    name: 'Bug Report',
    replacement: 'File issues on GitHub directly. Reports you already filed stay on GitHub.',
  },
};

export function isRetiredPlugin(pluginId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_PLUGINS, pluginId);
}

/** The refusal shown wherever a retired plugin would have loaded or installed. */
export function retiredPluginMessage(pluginId: string): string {
  const retired = RETIRED_PLUGINS[pluginId];
  if (!retired) return '';
  return `${retired.name} was retired in Clubhouse 1.0 and no longer loads. Its data is kept, and you can export it from its page in Settings. ${retired.replacement}`;
}
