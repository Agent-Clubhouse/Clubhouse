import { useEffect, useState } from 'react';
import type { GroupProjectRosterMember, GroupProjectRosterView } from '../../../shared/group-project-roster';
import { useGroupProjectStore } from '../../stores/groupProjectStore';

/** How often an open panel asks again: main's freshness window, so most asks are answered from its cache. */
export const ROSTER_REREAD_MS = 15_000;
/** A roster older than this is shown as possibly out of date, whatever its source said when it was read. */
export const ROSTER_AGED_MS = 3 * ROSTER_REREAD_MS;

/** A copy of a group project hosted on another computer, by the store. */
export function useIsCopy(groupProjectId: string): { copy: boolean; hostName: string } {
  const copy = useGroupProjectStore((s) => s.projects.find((p) => p.id === groupProjectId)?.network?.role === 'replica');
  const hostName = useGroupProjectStore((s) => s.projects.find((p) => p.id === groupProjectId)?.hostName) ?? 'its host';
  return { copy, hostName };
}

/** Whether a fetched roster is older than the renderer will vouch for. A host's own roster never ages. */
export function rosterAged(roster: Extract<GroupProjectRosterView, { status: 'available' }>, now = Date.now()): boolean {
  if (roster.source === 'host') return false;
  const age = now - Date.parse(roster.fetchedAt);
  return !(age >= 0 && age < ROSTER_AGED_MS);
}

/**
 * The host's roster of a group project (#3548), read again when `reload`
 * changes (a membership change), when the copy catches up, and when its host
 * comes or goes. Null until the first read, and when a read fails: callers
 * then claim nothing beyond the list they already have.
 */
export function useGroupRoster(groupProjectId: string, reload: unknown): GroupProjectRosterView | null {
  const [roster, setRoster] = useState<GroupProjectRosterView | null>(null);
  const seq = useGroupProjectStore((s) => s.projects.find((p) => p.id === groupProjectId)?.seq);
  const state = useGroupProjectStore((s) => s.projects.find((p) => p.id === groupProjectId)?.network?.state);
  // An open panel reads again on the host's freshness interval, so a host that goes away shows as stale.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ROSTER_REREAD_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => { setRoster(null); }, [groupProjectId]);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => window.clubhouse.groupProject.getRoster(groupProjectId)).then(
      (result) => { if (active) setRoster(result ?? null); },
      // telemetry-exempt: with no roster the section shows only what it already knows, labelled as such.
      () => { if (active) setRoster(null); },
    );
    return () => { active = false; };
  }, [groupProjectId, reload, seq, state, tick]);
  return roster;
}

/** Whether the roster is a copy's (fetched from another host, or unavailable from it). False when this computer hosts the group or nothing is known yet. */
export function isCopyRoster(roster: GroupProjectRosterView | null): boolean {
  return !!roster && (roster.status === 'unavailable' || roster.source !== 'host');
}

export const time = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'an unknown time' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** Why a copy shows only its own members, in a person's words. */
export function rosterUnavailableText(roster: Extract<GroupProjectRosterView, { status: 'unavailable' }>): string {
  const host = roster.hostName;
  switch (roster.reason) {
    case 'unsupported': return `${host} needs a Clubhouse update to show members on every computer.`;
    case 'offline': return `${host} is offline and hasn't sent its member list here yet.`;
    case 'host_removed': return `${host} left your network.`;
    case 'not_found': return `${host} didn't share this group project's members.`;
    case 'busy': return `${host} is busy. Try again in a minute.`;
    case 'not_network': return 'This group project isn\'t shared over the network.';
    default: return `Couldn't get the member list from ${host}.`;
  }
}

/** What a roster can't vouch for: one sentence each, empty when it is complete. */
export function rosterGaps(roster: Extract<GroupProjectRosterView, { status: 'available' }>, now = Date.now()): string[] {
  const gaps: string[] = [];
  if (!roster.stale && rosterAged(roster, now)) gaps.push(`As of ${time(roster.fetchedAt)}. ${roster.hostName} hasn't confirmed it since, so this may be out of date.`);
  const host = roster.source === 'host' ? 'this computer' : roster.hostName;
  if (roster.stale === 'offline') gaps.push(`Saved ${time(roster.fetchedAt)}. ${roster.hostName} is offline, so this may be out of date.`);
  else if (roster.stale === 'changed') gaps.push(`Saved ${time(roster.fetchedAt)}. The group project changed since.`);
  else if (roster.stale === 'failed') gaps.push(`Saved ${time(roster.fetchedAt)}. ${roster.hostName} couldn't be asked again just now.`);
  if (roster.hostInventory === 'partial') gaps.push(`Some projects on ${host} couldn't be read.`);
  for (const copy of roster.copies) {
    if (copy.state === 'offline') gaps.push(`${copy.label} was offline when last checked.`);
    else if (copy.state === 'truncated') gaps.push(`${copy.label} sent a shortened agent list.`);
    else if (copy.state === 'unknown') gaps.push(`${copy.label} couldn't be checked.`);
  }
  if (roster.copiesCut) gaps.push('More linked computers than can be listed.');
  if (roster.truncated) gaps.push(`Showing the first ${roster.members.length} members.`);
  return gaps;
}

const PROVENANCE: Readonly<Record<GroupProjectRosterMember['provenance'], string>> = {
  auto: 'joined by being in scope',
  explicit: 'added',
  linked: 'joined from a linked project',
};

/** A roster member's second line: computer, kind, how it joined, project. */
export function rosterMemberDetail(member: GroupProjectRosterMember): string {
  const kind = member.kind === 'helper' ? 'Helper' : member.kind === 'quick' ? 'Quick agent, this run only' : 'Agent';
  return [
    member.machineLabel, kind, PROVENANCE[member.provenance], member.projectLabel,
    member.inventory === 'unknown' ? 'not seen in its computer\'s inventory just now' : undefined,
  ].filter(Boolean).join(', ');
}

/** Complete, and not too old to vouch for now. */
export function rosterVouched(roster: Extract<GroupProjectRosterView, { status: 'available' }>, now = Date.now()): boolean {
  return roster.complete && !rosterAged(roster, now);
}
