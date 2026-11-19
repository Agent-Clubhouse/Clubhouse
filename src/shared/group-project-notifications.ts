import type { GroupProject } from './group-project-types';

/** Delivery configuration, not a receipt: the saved host record is authoritative. */
export function postNotificationState(project: Pick<GroupProject, 'metadata'>): 'On' | 'Off' {
  return postNotificationsAllowed(project) ? 'On' : 'Off';
}

/** Match ownGrantsOf: only an explicit Off overrides the default Allow. */
export function postNotificationsAllowed(project: Pick<GroupProject, 'metadata'>): boolean {
  const grants = project.metadata?.grants as { deliver?: unknown } | undefined;
  return grants?.deliver !== 'off';
}

export function postNotificationLabel(project: Pick<GroupProject, 'metadata'>): string {
  const state = postNotificationState(project);
  return `Post notifications: ${state}`;
}
