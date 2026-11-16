import type { ReactNode } from 'react';
import { RESERVED_APP_VIEW_IDS } from '../../shared/manifest-validator';

/**
 * Entries in the sidebar's app row that the app itself provides, beside the
 * plugin items (#3544). Not manifest rail items: they don't depend on a plugin
 * being enabled, and they add nothing to the plugin API. They open through the
 * app-view route (`plugin:app:<id>`) and render from the core view registry
 * (coreAppViews.tsx), which is consulted before any plugin's view.
 *
 * The ids are reserved: no plugin may claim one (RESERVED_APP_VIEW_IDS in the manifest validator).
 */

export const GROUP_PROJECTS_VIEW_ID = 'group-projects';

export interface CoreAppItem {
  id: string;
  label: string;
  /** Shown in the tooltip when it differs from the label. */
  title: string;
  icon: ReactNode;
}

/** A board above two member nodes, in the stroke style of the Canvas and Review icons. */
export const groupProjectsIcon = (size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="3" width="14" height="6" rx="1.5" />
    <path d="M8 9v4M16 9v4" />
    <circle cx="8" cy="16.5" r="3" />
    <circle cx="16" cy="16.5" r="3" />
  </svg>
);

/** In the order the row shows them, after the plugin items and before More. */
export const CORE_APP_ITEMS: readonly CoreAppItem[] = [
  { id: GROUP_PROJECTS_VIEW_ID, label: 'Group Projects', title: 'Group Projects', icon: groupProjectsIcon() },
];

export const coreAppItemFor = (id: string): CoreAppItem | undefined => CORE_APP_ITEMS.find((item) => item.id === id);

/** Whether an app view id belongs to the app, so no plugin can take it. The manifest validator enforces the same list. */
export function isReservedAppViewId(id: string): boolean {
  return RESERVED_APP_VIEW_IDS.includes(id);
}
