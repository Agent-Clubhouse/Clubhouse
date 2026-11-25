import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAssetCatalogStore } from '../src/main/services/asset-catalog/store';
import { createManagedStateStore } from '../src/main/services/managed-agents/state-store';
import { createManagedAgentsService } from '../src/main/services/managed-agents/service';
import { _resetSettingsAuditForTesting } from '../src/main/services/settings-audit';

/**
 * Installing every built-in writes each part to disk with an fsync, which took
 * over 10s in a test hook on a loaded hosted Windows runner. Install them once
 * per test file (`beforeAll`), then copy the result into each test's own root
 * (`beforeEach`); `ensureBuiltins` then finds them current and writes nothing.
 * Every test still has a private copy, so nothing is shared between tests.
 */
export const BUILTINS_SEED_BUDGET_MS = 60_000;

export async function buildBuiltinsSeed(prefix: string): Promise<string> {
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-seed-`));
  _resetSettingsAuditForTesting(false);
  await createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(seed, 'catalog') }),
    state: createManagedStateStore(path.join(seed, 'managed')),
    listProjects: async () => [],
    listAgents: async () => [],
    getAgent: async () => null,
    setManagedSetup: async () => {},
    isRunning: () => false,
  }).ensureBuiltins();
  return seed;
}

/** Copy the installed built-ins (the `catalog` and `managed` folders) into a test's root. */
export function copyBuiltinsSeed(seed: string, root: string): void {
  for (const name of fs.readdirSync(seed)) fs.cpSync(path.join(seed, name), path.join(root, name), { recursive: true });
}

export function removeBuiltinsSeed(seed: string | undefined): void {
  if (seed) fs.rmSync(seed, { recursive: true, force: true });
}
