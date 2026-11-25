/**
 * Workshop plugins retired for v1.0 (#2757, #2756). They live in the Workshop
 * repo, not here, so retiring them means Clubhouse refuses to load or install
 * them by id. At startup an installed copy and its data are removed
 * (src/main/services/retired-plugin-cleanup.ts), except project files a
 * repository tracks.
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
    replacement: 'There is no built-in board. Boards committed to a project\'s repository are left in .clubhouse/plugin-data/kanboss.',
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
  return `${retired.name} was retired in Clubhouse 1.0 and no longer loads. Clubhouse removes it and its data. ${retired.replacement}`;
}
