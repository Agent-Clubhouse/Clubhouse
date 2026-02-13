import { registerPlugin } from './registry';
import { filesPlugin } from './files-plugin';
import { notesPlugin } from './notes-plugin';
import { gitPlugin } from './git-plugin';
import { schedulerPlugin } from './scheduler-plugin';
import { terminalPlugin } from './terminal-plugin';

/**
 * Imports and registers all built-in plugins.
 * Call once at app startup before rendering.
 */
export function registerAllPlugins(): void {
  registerPlugin(filesPlugin);
  registerPlugin(notesPlugin);
  registerPlugin(gitPlugin);
  registerPlugin(schedulerPlugin);
  registerPlugin(terminalPlugin);
}
