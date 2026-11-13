import { createHash, randomBytes } from 'crypto';

/** A complete inventory, assembled by the host and dependent stores. */
export interface GroupProjectDeletionInventory {
  groupProjectId: string;
  members: string[];
  exclusions: string[];
  canvases: string[];
  actions: string[];
  grants: string[];
  messages: number;
  topics: number;
  machines: string[];
  /** Opaque revisions for changes that do not alter the displayed counts. */
  revisions: string[];
}

export interface GroupProjectDeletionDependencies {
  inventory: (id: string) => Promise<GroupProjectDeletionInventory>;
  /** Revalidate the inventory and perform the cascade under the stores' mutation guards. */
  cascade: (id: string, expected: GroupProjectDeletionInventory) => Promise<void>;
  now?: () => number;
}

const TOKEN_LIFETIME_MS = 5 * 60_000;

/** A preview token is scoped to one caller, one project and one exact inventory. */
export function createGroupProjectDeletionService(deps: GroupProjectDeletionDependencies) {
  const tokens = new Map<string, { caller: number; id: string; digest: string; expires: number }>();
  const deleting = new Set<string>();
  const now = deps.now ?? Date.now;
  const digest = (value: GroupProjectDeletionInventory) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  return {
    async preview(id: string, caller: number) {
      const inventory = await deps.inventory(id);
      if (inventory.groupProjectId !== id) throw new Error('The impact check returned the wrong group project.');
      const currentTime = now();
      for (const [key, entry] of tokens) if (entry.expires <= currentTime) tokens.delete(key);
      const token = randomBytes(32).toString('hex');
      tokens.set(token, { caller, id, digest: digest(inventory), expires: currentTime + TOKEN_LIFETIME_MS });
      return { ...inventory, token };
    },
    async confirm(id: string, caller: number, token: string) {
      const entry = tokens.get(token);
      tokens.delete(token);
      if (!entry || entry.caller !== caller || entry.id !== id || entry.expires <= now()) {
        throw new Error('The impact check has expired. Refresh it before deleting.');
      }
      if (deleting.has(id)) throw new Error('Deletion is already in progress.');
      deleting.add(id);
      try {
        const inventory = await deps.inventory(id);
        if (inventory.groupProjectId !== id || digest(inventory) !== entry.digest) {
          throw new Error('The group project changed. Refresh the impact check before deleting.');
        }
        await deps.cascade(id, inventory);
      } finally {
        deleting.delete(id);
      }
    },
  };
}
