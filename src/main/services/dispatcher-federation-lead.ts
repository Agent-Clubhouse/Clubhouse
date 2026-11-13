/**
 * The network-wide lead Dispatcher (#3351). A person chooses it in Settings ›
 * Dispatcher on any computer member, and the choice reaches every other one.
 *
 * - It travels as `extra.lead` on the pinned connection exchange between each
 *   pair of computer members (`/api/v1/network/connections`, #3345), both ways.
 *   That exchange runs on every connect and reconnect, so a member that was off
 *   catches up, and a change is pushed to every connected member at once.
 * - A member that adopts a newer record passes it on, so members that can't
 *   reach the chooser still get it.
 * - The newest record wins everywhere (`compareLeadRecords`).
 * - Removing the lead's machine clears it: each member that sees the removal
 *   writes "no lead" one past the record it had, naming the machine that left.
 * - No agent can change it: there's no tool or grant for it, only IPC from
 *   Settings and records from other members' own Settings.
 */

import { appLog } from './log-service';
import { createSettingsStore, type SettingsCommitPrecondition } from './settings-store';
import type { FederationPublicationGuard } from './dispatcher-federation-policy';
import * as annexIdentity from './annex-identity';
import * as annexSettings from './annex-settings';
import { listPeers, peerNeedsPairing } from './annex-peers';
import { remoteFederationController } from './dispatcher-federation';
import { isDispatcherEnabled, onDispatcherChanged } from './dispatcher/dispatcher-service';
import { onDevicePresenceChanged, onDevicesChanged } from './annex-device-signal';
import { currentView, onMembershipChanged, ownPairing } from './annex-network-membership';
import {
  NO_LEAD, compareLeadRecords, readLeadRecord, sameLeadRecord,
  type DispatcherLeadState, type LeadChoice, type LeadRecord, type LeadRole,
} from '../../shared/dispatcher-lead';

interface LeadFile {
  record: LeadRecord;
  /** The last record each member sent, by machine, for "confirmed by". */
  heard: Record<string, LeadRecord>;
  /** The lead's name when it was chosen or learned, so it can be named after its machine is removed. */
  leadName?: string;
  /**
   * Take back (#3353): this computer stopped following the lead in this record.
   * Only this computer's; it never travels. A different record (a new choice) follows again.
   */
  tookBack?: LeadRecord;
}

const store = createSettingsStore<LeadFile>('dispatcher-lead.json', { record: NO_LEAD, heard: {} }, undefined, { atomic: true, audit: { key: 'dispatcher_lead' } });

const lower = (id: string) => id.toLowerCase();
const selfId = (): string | undefined => annexIdentity.getIdentity()?.fingerprint.toLowerCase();
const selfName = (): string => annexSettings.getSettings().alias || 'This computer';

function computerMembers() {
  return listPeers().filter((p) => p.role === 'member' && p.kind !== 'phone' && !peerNeedsPairing(p));
}

function read(): LeadFile {
  const file = store.get();
  const tookBack = readLeadRecord(file.tookBack);
  return {
    record: readLeadRecord(file.record) ?? NO_LEAD, heard: file.heard ?? {},
    ...(file.leadName && { leadName: file.leadName }), ...(tookBack && { tookBack }),
  };
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

interface LeadHooks {
  /** Send this machine's record to every connected computer member now. */
  push: () => void;
  /** Whether a member is connected now. */
  connected: (machine: string) => boolean;
}
let hooks: LeadHooks | undefined;
const listeners = new Set<() => void>();

/** Hears every change to what Settings shows for Lead. */
export function onLeadChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function changed(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* telemetry-exempt: one listener failing must not stop the others */ }
  }
}

async function save(next: LeadFile, push: boolean, precondition?: SettingsCommitPrecondition): Promise<void> {
  const lead = next.record.lead;
  const name = lead ? (lead === selfId() ? selfName() : computerMembers().find((p) => lower(p.fingerprint) === lead)?.alias) : undefined;
  const { leadName: _old, tookBack, ...rest } = next;
  await store.save({
    ...rest, ...(lead && (name ?? next.leadName) && { leadName: name ?? next.leadName }),
    // A take-back only lasts while the record it was taken from does.
    ...(tookBack && sameLeadRecord(tookBack, next.record) && { tookBack }),
  }, precondition);
  changed();
  if (push) hooks?.push();
}

// ── The record ────────────────────────────────────────────────────────────────

export function leadRecord(): LeadRecord {
  return read().record;
}

/** This machine's relation to the lead. */
export function leadRole(record: LeadRecord = leadRecord()): LeadRole {
  if (!record.lead) return 'peer';
  return record.lead === selfId() ? 'lead' : 'follower';
}

/** A follower that hasn't taken back: its Dispatcher pane is the lead's chat. */
export function isFollowingLead(): boolean {
  const file = read();
  return leadRole(file.record) === 'follower' && !sameLeadRecord(file.tookBack, file.record);
}

/**
 * Take back (#3353): this computer uses its own Dispatcher chat again. Only a
 * person does this, from the follower pane. Other followers, and the lead, are
 * unchanged.
 */
export async function takeBackFromLead(): Promise<void> {
  const file = read();
  if (leadRole(file.record) !== 'follower') throw new Error('This computer isn’t following another computer’s Dispatcher.');
  if (sameLeadRecord(file.tookBack, file.record)) return;
  await save({ ...file, tookBack: file.record }, false);
  appLog('core:dispatcher', 'info', 'Took this computer’s Dispatcher back from the lead', { meta: { rev: file.record.rev } });
}

/** Follow the lead again after Take back, from Settings › Dispatcher. */
export async function followLeadAgain(): Promise<void> {
  const file = read();
  if (!file.tookBack) return;
  const { tookBack: _gone, ...rest } = file;
  await save(rest, false);
}

/**
 * A person's choice in Settings: a member's machine, this machine, or null for
 * peers. Refuses a machine that isn't a computer in this network.
 */
export async function chooseLead(machine: string | null, now = Date.now()): Promise<LeadRecord> {
  const self = selfId();
  if (!self) throw new Error('This computer has no Annex identity yet. Turn on Annex Network first.');
  const members = computerMembers();
  if (members.length === 0) throw new Error('This computer isn’t in an Annex Network with another computer.');
  const lead = machine === null ? null : lower(machine);
  if (lead !== null && lead !== self && !members.some((p) => lower(p.fingerprint) === lead)) {
    throw new Error('That computer isn’t in this Annex Network.');
  }
  const file = read();
  if (file.record.lead === lead && !file.record.clearedFor) return file.record;
  const record: LeadRecord = { v: 1, lead, rev: file.record.rev + 1, changedAt: new Date(now).toISOString(), by: self };
  await save({ ...file, record }, true);
  appLog('core:dispatcher', 'info', 'Lead Dispatcher chosen here', { meta: { role: leadRole(record), rev: record.rev } });
  return record;
}

/** What goes out as `extra.lead` on the connection exchange. */
export function leadShare(): { lead: LeadRecord } | undefined {
  if (!selfId()) return undefined;
  return { lead: read().record };
}

/**
 * Another computer member's `extra`. Notes what it said (for "confirmed by"),
 * adopts its record when it's newer, and passes an adopted one on.
 */
export async function learnLeadShare(machine: string, extra: unknown, publication?: FederationPublicationGuard): Promise<void> {
  const from = lower(machine);
  // Only under the pairing that authenticated this exchange (#3345's guard), so a record can't cross a remove and re-pair.
  const current = () => (!publication || publication.current()) && computerMembers().some((p) => lower(p.fingerprint) === from);
  if (!current()) return;
  const theirs = readLeadRecord((extra as { lead?: unknown } | null | undefined)?.lead);
  if (!theirs) return;
  const file = read();
  const adopt = compareLeadRecords(theirs, file.record) > 0;
  const heardBefore = file.heard[from];
  if (!adopt && sameLeadRecord(heardBefore, theirs)) return;
  const keep = new Set(computerMembers().map((p) => lower(p.fingerprint)));
  const heard = Object.fromEntries(Object.entries(file.heard).filter(([id]) => keep.has(id)));
  heard[from] = theirs;
  const stale = new Error('The lead record came from an earlier network pairing.');
  try {
    await save({ ...file, record: adopt ? theirs : file.record, heard }, adopt, { prepare: async () => {}, check: () => { if (!current()) throw stale; } });
  } catch (err) {
    if (err === stale) return;
    throw err;
  }
  if (adopt) {
    appLog('core:dispatcher', 'info', 'Lead Dispatcher learned from another computer', { meta: { role: leadRole(theirs), rev: theirs.rev } });
    await reconcileMembership();
  }
}

/**
 * Membership changed. The lead's machine removed from the network clears the
 * lead for everyone. This machine leaving the network forgets the record, so a
 * network it joins later isn't overruled by an old one.
 */
export async function reconcileMembership(now = Date.now()): Promise<void> {
  const self = selfId();
  const file = read();
  const members = computerMembers();
  if (!self || (members.length === 0 && !ownPairing())) {
    if (file.record.rev !== 0 || Object.keys(file.heard).length > 0) await save({ record: NO_LEAD, heard: {} }, false);
    return;
  }
  const lead = file.record.lead;
  if (!lead || lead === self || members.some((p) => lower(p.fingerprint) === lead)) return;
  const removal = currentView().removals.find((r) => lower(r.fingerprint) === lead);
  if (!removal) return;
  const record: LeadRecord = {
    v: 1, lead: null, rev: file.record.rev + 1, changedAt: new Date(now).toISOString(), by: self,
    clearedFor: { machine: lead, name: file.leadName ?? 'A computer' },
  };
  await save({ ...file, record }, true);
  appLog('core:dispatcher', 'info', 'Lead Dispatcher cleared: its computer left the network', { meta: { rev: record.rev } });
}


// ── What Settings shows ───────────────────────────────────────────────────────

export function getLeadState(): DispatcherLeadState {
  const self = selfId();
  const members = computerMembers();
  const { record, heard, leadName, tookBack } = read();
  const connected = hooks?.connected ?? (() => false);
  const choices: LeadChoice[] = !self ? [] : [
    { machine: self, name: selfName(), self: true, online: true, dispatcherOn: isDispatcherEnabled() },
    ...members.map((p) => ({
      machine: lower(p.fingerprint), name: p.alias || 'A computer', self: false, online: connected(lower(p.fingerprint)),
      dispatcherOn: remoteFederationController(p.fingerprint)?.enabled ?? null,
    })),
  ];
  const lead = record.lead ? choices.find((c) => c.machine === record.lead)
    ?? { machine: record.lead, name: leadName ?? 'Another computer', self: false, online: false, dispatcherOn: null } : null;
  const confirmedBy = members.filter((p) => sameLeadRecord(heard[lower(p.fingerprint)], record)).map((p) => p.alias || 'A computer');
  const waitingOn = members.filter((p) => !sameLeadRecord(heard[lower(p.fingerprint)], record)).map((p) => p.alias || 'A computer');
  const changedBy = record.rev === 0 ? null : choices.find((c) => c.machine === record.by)?.name ?? null;
  return {
    // Kept after the last other computer leaves, so the page can say who left.
    available: !!self && (members.length > 0 || record.rev > 0),
    canChoose: !!self && members.length > 0,
    role: leadRole(record),
    lead,
    choices,
    confirmedBy,
    waitingOn: record.rev === 0 ? [] : waitingOn,
    clearedFor: record.lead === null && record.clearedFor ? record.clearedFor.name : null,
    changedByName: changedBy,
    changedAt: record.rev === 0 ? null : record.changedAt,
    following: leadRole(record) === 'follower' && !sameLeadRecord(tookBack, record),
    tookBack: leadRole(record) === 'follower' && sameLeadRecord(tookBack, record),
    leadLastSeen: record.lead ? members.find((p) => lower(p.fingerprint) === record.lead)?.lastSeen ?? null : null,
    outbox: { waiting: 0, oldestAt: null, expired: 0, failed: null },
    localNews: { count: 0, needsUser: false },
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────

/** Starts following membership. Called once the connection exchange is running. */
export function startDispatcherLead(h: LeadHooks): () => void {
  hooks = h;
  // A removal is saved and its pairing ended in either order, so both signals recheck.
  const recheck = () => { void reconcileMembership().catch(logError).finally(changed); };
  const offMembership = onMembershipChanged(recheck);
  const offDevices = onDevicesChanged(recheck);
  const offPresence = onDevicePresenceChanged(changed);
  // This computer's switch shows on its own choice.
  const offDispatcher = onDispatcherChanged(changed);
  void reconcileMembership().catch(logError);
  return () => {
    offMembership();
    offDevices();
    offPresence();
    offDispatcher();
    if (hooks === h) hooks = undefined;
  };
}

function logError(err: unknown): void {
  appLog('core:dispatcher', 'warn', 'Could not update the lead Dispatcher', { meta: { error: err instanceof Error ? err.message : String(err) } });
}

/** For tests. */
export function _resetLeadForTesting(): void {
  hooks = undefined;
  listeners.clear();
}
