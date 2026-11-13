/**
 * The per-group-project membership file (#3356): `<id>/membership.json`.
 * Persistence only; the host serializes and sequences writes, and #3357's
 * policy decides what goes in it. Unknown fields are kept.
 */
import type { GroupProjectMembership } from '../../shared/group-project-types';
import { canonicalMemberAddress } from '../../shared/group-project-members';
import { membershipPath } from './group-project-paths';
import { readJsonFile, writeJsonFile } from './group-project-json-file';

export function emptyMembership(): GroupProjectMembership {
  return { version: 1, autoJoin: false, explicit: [], excluded: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Refuses a malformed record, and duplicate addresses, rather than guessing. */
export function validateMembership(value: unknown, hostMachine: string | null = null): GroupProjectMembership {
  if (!isRecord(value) || value.version !== 1 || typeof value.autoJoin !== 'boolean'
    || !Array.isArray(value.explicit) || !Array.isArray(value.excluded)) {
    throw new Error('Group project membership is not a valid version 1 record.');
  }
  const unique = (list: unknown[], label: string, dated: string): Array<Record<string, unknown> & { address: string }> => {
    const seen = new Set<string>();
    return list.map((entry) => {
      if (!isRecord(entry) || typeof entry.address !== 'string' || !entry.address.trim() || typeof entry[dated] !== 'string') {
        throw new Error(`Group project membership has an invalid ${label} entry.`);
      }
      const address = canonicalMemberAddress(entry.address, hostMachine);
      if (seen.has(address)) throw new Error(`Group project membership lists ${address} twice in ${label}.`);
      seen.add(address);
      return { ...entry, address };
    });
  };
  const explicit = unique(value.explicit, 'explicit', 'addedAt');
  for (const entry of explicit) {
    if (entry.kind !== 'durable' && entry.kind !== 'helper' && entry.kind !== 'quick') {
      throw new Error('Group project membership has an explicit entry with an unknown kind.');
    }
  }
  return {
    ...value,
    version: 1,
    autoJoin: value.autoJoin,
    explicit: explicit as GroupProjectMembership['explicit'],
    excluded: unique(value.excluded, 'excluded', 'excludedAt') as GroupProjectMembership['excluded'],
  };
}

export function readMembershipFile(id: string, hostMachine: string | null): Promise<GroupProjectMembership> {
  return readJsonFile(membershipPath(id), emptyMembership, (value) => validateMembership(value, hostMachine));
}

export function writeMembershipFile(id: string, membership: GroupProjectMembership): Promise<void> {
  return writeJsonFile(membershipPath(id), membership);
}
