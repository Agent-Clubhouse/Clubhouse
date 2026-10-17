import type { Agent, Project } from '../../../shared/types';
import type { AgentDot } from '../../chrome/sidebar/treeModel';

/** Group names, in the order the palette lists them with an empty query. */
export const CATEGORY = {
  recent: 'Recent',
  agents: 'Agents',
  projects: 'Projects',
  hosts: 'Hosts',
  canvases: 'Canvases',
  settings: 'Settings',
  commands: 'Commands',
  help: 'Help',
} as const;

/** The small glyph in front of a row that is not an agent or a project. */
export type CommandIcon = 'command' | 'settings' | 'help' | 'canvas' | 'host';

export interface CommandItem {
  id: string;
  label: string;
  category: string;
  keywords?: string[];
  shortcut?: string;
  detail?: string;
  /** Agents lead with the sidebar's status dot and 18px avatar. */
  agent?: Agent;
  dot?: AgentDot;
  /** Projects lead with the sidebar's project square. */
  project?: Project;
  projectIconUrl?: string;
  icon?: CommandIcon;
  /** Listed only once something is typed (each project's settings pages). */
  searchOnly?: boolean;
  execute: () => void;
}
