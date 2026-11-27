import type { SettingsSubPage } from '../../../shared/types';
import { useUIStore } from '../../stores/uiStore';
import { getHelpSections } from '../help/help-content';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { openAutoSettings, openDispatcherSettings, openDispatcherSetup } from '../dispatcher/dispatcherNav';
import { useWelcomeTourStore } from './welcomeTourStore';

/**
 * Everything a tour button does: it closes the tour and moves you somewhere.
 * None of these change a setting, an agent or a connection. Those stay with
 * the page you land on, and its own confirmations.
 */

/**
 * Help topics the tour links to, most specific first, using the ids the 1.0
 * help pages (#3902) give them. Until a page lands, the next id in its list is
 * the nearest page that exists. `fromClassic` has no stand-in: its link shows
 * only once Coming from classic is in Help.
 */
export const HELP_LINKS = {
  managed: ['agents-managed', 'agents-durable'],
  dispatcher: ['agents-dispatcher'],
  helpers: ['agents-orchestrated-helpers'],
  smartRouting: ['agents-orchestrated-helpers'],
  fromClassic: ['coming-from-classic'],
  access: ['agents-access', 'agents-overview'],
  connections: ['agents-connections', 'agents-overview'],
  groupProjects: ['group-projects'],
  actions: ['agents-actions'],
  annex: ['settings-annex'],
  privacy: ['settings-privacy', 'settings-logging'],
  usage: ['agents-clis-usage', 'orchestrators'],
  gettingStarted: ['getting-started'],
} as const satisfies Record<string, readonly string[]>;

/** Links shown only once their page exists, since nothing else says the same. */
export const LINKS_WITHOUT_STAND_IN: readonly HelpLink[] = ['fromClassic'];

export type HelpLink = keyof typeof HELP_LINKS;

/** The first of `ids` that Help has, with its section. Null when none is there. */
export function findHelpTopic(ids: readonly string[]): { sectionId: string; topicId: string } | null {
  const sections = getHelpSections();
  for (const id of ids) {
    const section = sections.find((s) => s.topics.some((t) => t.id === id));
    if (section) return { sectionId: section.id, topicId: id };
  }
  return null;
}

function leaveTour(): void {
  useWelcomeTourStore.getState().closeTour('navigate');
}

/** Open Help at a topic, or at its start when none of the ids is there yet. */
export function openHelpLink(link: HelpLink | null): void {
  leaveTour();
  const ui = useUIStore.getState();
  if (ui.explorerTab !== 'help') ui.toggleHelp();
  const found = link ? findHelpTopic(HELP_LINKS[link]) : null;
  if (!found) return;
  // setHelpSection clears the topic, so the topic goes second.
  useUIStore.getState().setHelpSection(found.sectionId);
  useUIStore.getState().setHelpTopic(found.topicId);
}

export function openAppSettings(page: SettingsSubPage): void {
  leaveTour();
  const ui = useUIStore.getState();
  ui.setSettingsContext('app');
  ui.setSettingsSubPage(page);
  if (ui.explorerTab !== 'settings') ui.toggleSettings();
}

/** The Dispatcher's own setup (#3047), which owns its first conversation. With it turned off, Settings › Dispatcher. */
export function openDispatcherSetupFromTour(): void {
  leaveTour();
  if (useDispatcherStore.getState().project) openDispatcherSetup();
  else openDispatcherSettings();
}

/** Settings › Smart routing, where the models for each difficulty are chosen. */
export function openSmartRoutingSettings(): void {
  leaveTour();
  openAutoSettings();
}
