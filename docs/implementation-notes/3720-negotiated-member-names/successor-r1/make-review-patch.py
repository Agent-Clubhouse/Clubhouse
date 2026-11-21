"""Build an UNAPPLIED review artifact from bound git objects; never writes product files."""
from pathlib import Path
import subprocess, difflib, hashlib, json
ROOT = Path(__file__).resolve().parent
BASE = '50cb77ab6ccf9f383a39e59db308f4f8336051ea'
paths = ['src/main/services/settings-store.ts', 'src/main/services/annex-settings.ts', 'src/main/ipc/annex-handlers.ts', 'src/main/services/clubhouse-mcp/tools/device-tools.ts', 'src/main/index.ts']
old = {p: subprocess.check_output(['git', 'show', BASE + ':' + p]).decode() for p in paths}
new = old.copy()
p = paths[0]
s = new[p]
needle = '''    rollBackFailedSaves?: boolean;'''
assert s.count(needle) == 1
s = s.replace(needle, needle + '''
    /** REVIEW ONLY: Annex opt-in; cache and queued mutations see only committed values.
     * Uses pendingWrite, not another lock. Default optimistic behavior is unchanged. */
    publishAfterCommit?: true;''')
needle = '''  const store: SettingsStore<T> = {'''
helper = '''  // REVIEW ONLY: proposed opt-in seam. Not executed or approved.
  function queueCommittedChange(change: (current: T) => T, precondition?: SettingsCommitPrecondition): Promise<T> {
    precondition?.check();
    if (!cacheLoaded) loadSettings();
    const result = pendingWrite.catch((err): void => {
      console.warn(`[settings-store] Previous write to ${filename} failed:`, err instanceof Error ? err.message : err);
    }).then(() => persist.timed('settings', async () => {
      if (precondition) { await precondition.prepare(); precondition.check(); }
      const before = cloneSettings(store.get());
      // One callback at its actual disk turn; no optimistic publication.
      const current = cloneSettings(before);
      const changed = change(current);
      if (options?.skipUnchangedUpdates && changed === current) return cloneSettings(before);
      const attempted = cloneSettings(changed);
      const serialized = JSON.stringify(attempted, null, 2);
      if (needsRecoveryCopy) {
        backupUnreadableSettings(getFilePath());
        needsRecoveryCopy = false;
      }
      await replaceFile(getFilePath(), serialized, options?.mode, precondition);
      // PRIMARY COMMITTED. No later guard may describe this as rollback/no-write.
      cachedSettings = attempted;
      cacheLoaded = true;
      displaySnapshot = options?.displaySnapshot ? {
        value: attempted as Readonly<T>,
        primary: attempted !== null && typeof attempted === 'object' && !Array.isArray(attempted)
          ? cloneSettings(attempted) as Record<string, unknown> : 'unreadable',
        origin: 'accepted-save', observedAt: Date.now(),
      } : undefined;
      if (options?.audit && storeAuditor) void reportAudit(before, cloneSettings(attempted));
      return cloneSettings(attempted);
    }));
    pendingWrite = result.then(() => undefined);
    return result;
  }

'''
assert s.count(needle) == 1
s = s.replace(needle, helper + needle)
needle = '''    save(settings: T, precondition?: SettingsCommitPrecondition) {
      precondition?.check();'''
assert s.count(needle) == 1
s = s.replace(needle, '''    save(settings: T, precondition?: SettingsCommitPrecondition) {
      if (options?.publishAfterCommit) {
        const requested = cloneSettings(settings);
        return queueCommittedChange(() => requested, precondition).then(() => undefined);
      }
      precondition?.check();''')
needle = '''    update(fn: (current: T) => T, precondition?: SettingsCommitPrecondition): Promise<T> {
      const result = updateLock'''
assert s.count(needle) == 1
s = s.replace(needle, '''    update(fn: (current: T) => T, precondition?: SettingsCommitPrecondition): Promise<T> {
      if (options?.publishAfterCommit) return queueCommittedChange(fn, precondition);
      const result = updateLock''')
# backupUnreadableSettings accepts a filename, not an absolute path.
s = s.replace('backupUnreadableSettings(getFilePath());', 'backupUnreadableSettings(filename);')
new[p] = s
p = paths[1]
s = new[p]
s = s.replace("import { createSettingsStore } from './settings-store';", "import { createSettingsStore, type SettingsCommitPrecondition } from './settings-store';")
s = s.replace("const store = createSettingsStore<AnnexSettings>", '''/** REVIEW ONLY: server-owned accepted-write witness, not an authority token. */
export interface AnnexNameIntentWitness { id: string; epoch: string }
interface StoredAnnexSettings extends AnnexSettings { memberNameIntentCommit?: AnnexNameIntentWitness }

const store = createSettingsStore<StoredAnnexSettings>''')
s = s.replace("{ rollBackFailedSaves: true, audit: { key: 'annex' } }", "{ rollBackFailedSaves: true, publishAfterCommit: true, audit: { key: 'annex', ignore: ['memberNameIntentCommit'] } }")
a = s.index('export function getSettings(): AnnexSettings {')
b = s.index('/** Whether Annex Network is on', a)
s = s[:a] + '''function publicSettings(raw: StoredAnnexSettings): AnnexSettings {
  const clean = { ...migrateSettings(raw) } as StoredAnnexSettings;
  delete clean.enabled;
  delete clean.memberNameIntentCommit;
  return clean;
}

export function getSettings(): AnnexSettings {
  return publicSettings(store.get());
}

/** Same local save interface, never accepts a caller-owned private witness. */
export async function saveSettings(settings: AnnexSettings, precondition?: SettingsCommitPrecondition): Promise<void> {
  const requested = publicSettings(settings);
  await store.update((current) => ({ ...requested,
    ...(current.memberNameIntentCommit && { memberNameIntentCommit: current.memberNameIntentCommit }),
  }), precondition);
}

/** REVIEW ONLY: explicit emergency option retires only the server-owned witness. */
export async function updateSettings(
  change: (current: AnnexSettings) => AnnexSettings,
  retireNameIntent = false,
): Promise<AnnexSettings> {
  const result = await store.update((current) => ({
    ...publicSettings(change(publicSettings(current))),
    ...(!retireNameIntent && current.memberNameIntentCommit && { memberNameIntentCommit: current.memberNameIntentCommit }),
  }));
  return publicSettings(result);
}

function sameField(a: AnnexSettings, b: AnnexSettings, key: string): boolean {
  const left = a as unknown as Record<string, unknown>, right = b as unknown as Record<string, unknown>;
  return Object.hasOwn(left, key) === Object.hasOwn(right, key) && JSON.stringify(left[key]) === JSON.stringify(right[key]);
}

/** One explicit guarded patch. Untouched fields rebase; a touched conflict refuses it all. */
export async function commitNameSettingsPatch(
  baseline: AnnexSettings, requested: AnnexSettings, witness: AnnexNameIntentWitness,
  precondition: SettingsCommitPrecondition,
): Promise<{ previous: AnnexSettings; settings: AnnexSettings }> {
  const expected = publicSettings(baseline), desired = publicSettings(requested);
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(desired)])]
    .filter((key) => !sameField(expected, desired, key));
  let previous: AnnexSettings | undefined;
  const committed = await store.update((current) => {
    const actual = publicSettings(current);
    for (const key of changed) {
      if (!sameField(expected, actual, key)) throw new Error('Annex settings changed before the name save; no fields were saved.');
    }
    previous = actual;
    const next = { ...actual } as unknown as Record<string, unknown>;
    for (const key of changed) {
      if (Object.hasOwn(desired, key)) next[key] = (desired as unknown as Record<string, unknown>)[key];
      else delete next[key];
    }
    return { ...next, memberNameIntentCommit: structuredClone(witness) } as unknown as StoredAnnexSettings;
  }, precondition);
  return { previous: previous!, settings: publicSettings(committed) };
}

/** Main-only recovery check: never infer accepted intent from equal Alias text. */
export function acceptedNameIntent(): AnnexNameIntentWitness | undefined {
  const witness = store.get().memberNameIntentCommit;
  return witness && structuredClone(witness);
}

/** Retire only this intent, never a newer accepted witness. */
export async function retireNameIntent(id: string): Promise<void> {
  await store.update((current) => {
    if (current.memberNameIntentCommit?.id !== id) return current;
    const next = { ...current };
    delete next.memberNameIntentCommit;
    return next;
  });
}

''' + s[b:]
new[p] = s
p = paths[2]
s = new[p]
s = s.replace("import { deliveryHash } from '../services/annex-delivery-store';", "import { deliveryHash } from '../services/annex-delivery-store';\n// REVIEW ONLY: new independent UI receipt API, implementation separately reviewed.\nimport { captureNameUiAuthority, NameMutationFailure } from './annex-name-ui-authority';")
# Local generation spans only this registered handler set; no client lifecycle edits.
s = s.replace('''export function registerAnnexHandlers(): void {
''', '''export function registerAnnexHandlers(): void {
  let emergencyGeneration = 0;
''', 1)
old_queue = '''    (_event, settings) => {
      const requested = structuredClone(settings);
      const apply = async () => {
        const previous = annexSettings.getSettings();
        await annexSettings.saveSettings(requested);
        settingsChanged('annex');
        applyNetworkSettings(requested, previous);
      };'''
new_queue = '''    (event, settings) => {
      const requested = structuredClone(settings);
      const admittedGeneration = emergencyGeneration;
      const assertUiAuthorized = captureNameUiAuthority(event);
      const apply = async () => {
        const previous = annexSettings.getSettings();
        const changesName = membership.localAliasChanged(previous, requested);
        // Non-name saves do not touch naming health. Old enabling work cannot
        // revive a runtime that was synchronously stopped after its admission.
        const wouldEnable = (!previous.enableServer && requested.enableServer)
          || (!previous.enableClient && requested.enableClient)
          || (previous.networkEnabled === false && requested.networkEnabled !== false);
        if (admittedGeneration !== emergencyGeneration && (changesName || wouldEnable)) {
          throw new NameMutationFailure('superseded');
        }
        if (!changesName) {
          await annexSettings.saveSettings(requested);
          settingsChanged('annex');
          if (admittedGeneration !== emergencyGeneration && wouldEnable) {
            throw new NameMutationFailure('committed_unconfirmed');
          }
          applyNetworkSettings(requested, previous);
          return;
        }
        const assertIntentAuthorized = () => {
          assertUiAuthorized();
          if (admittedGeneration !== emergencyGeneration) throw new NameMutationFailure('superseded');
        };
        const intent = await membership.reserveLocalAliasIntent(previous, requested, assertIntentAuthorized);
        const assertCommit = () => {
          assertIntentAuthorized();
          membership.assertLocalAliasIntentCurrent(intent);
        };
        let committed: { previous: AnnexSettings; settings: AnnexSettings };
        try {
          committed = await annexSettings.commitNameSettingsPatch(previous, requested, intent.witness, {
            prepare: async () => { /* no IO/wait; one reservation outside this check */ },
            check: assertCommit,
          });
        } catch (error) {
          // Exact-id disposal only. Failed primary commit has no accepted
          // witness, so later matching text cannot recover this intent.
          await membership.discardLocalAliasIntent(intent);
          throw error;
        }
        // PRIMARY COMMITTED. A later failure is partial, never rollback.
        settingsChanged('annex');
        if (admittedGeneration !== emergencyGeneration) {
          membership.invalidateLocalAliasIntent(intent); // synchronous, exact id
          void annexSettings.retireNameIntent(intent.witness.id).catch(() => {
            membership.reportNameUnconfirmed(intent);
          });
          throw new NameMutationFailure('committed_unconfirmed');
        }
        // Existing internal abortControllerReads -> devicesChanged order kept.
        applyNetworkSettings(committed.settings, committed.previous);
        try {
          assertCommit();
          await membership.activateLocalAliasIntent(intent, assertCommit);
          assertCommit();
        } catch {
          throw new NameMutationFailure('committed_unconfirmed');
        }
      };'''
assert s.count(old_queue) == 1
s = s.replace(old_queue, new_queue)
needle = '''  ipcMain.handle(IPC.ANNEX.GET_STATUS, () => {'''
addition = '''  // REVIEW ONLY: no second settings queue; no settings save/runtime apply.
  ipcMain.handle(IPC.ANNEX.USE_LOCAL_ALIAS, (event) => {
    const admittedGeneration = emergencyGeneration;
    const assertUiAuthorized = captureNameUiAuthority(event);
    const assertAuthorized = () => {
      assertUiAuthorized();
      if (admittedGeneration !== emergencyGeneration) throw new NameMutationFailure('superseded');
    };
    const use = async () => {
      assertAuthorized();
      await membership.useLocalAlias(annexSettings.getSettings(), assertAuthorized);
      assertAuthorized();
    };
    const used = settingsWrites.then(use, use);
    settingsWrites = used;
    return used;
  });

'''
assert s.count(needle) == 1
s = s.replace(needle, addition + needle, 1)
s = s.replace('''  ipcMain.handle(IPC.ANNEX.DISABLE_AND_DISCONNECT, async () => {
    annexServer.stop();''', '''  ipcMain.handle(IPC.ANNEX.DISABLE_AND_DISCONNECT, async () => {
    emergencyGeneration++;
    annexServer.stop();''')
s = s.replace('''    await annexSettings.saveSettings({ ...annexSettings.getSettings(), enableServer: false, enableClient: false });''', '''    await annexSettings.updateSettings((current) => ({ ...current, enableServer: false, enableClient: false }), true);''')
s = s.replace('''    // Stop everything first
    annexServer.stop();''', '''    // Supersede old intent/runtime work before the existing immediate stop.
    emergencyGeneration++;
    // Stop everything first
    annexServer.stop();''')
old_purge = '''    await annexSettings.saveSettings({
      enableServer: false,
      enableClient: false,
      deviceName: annexSettings.getSettings().deviceName, // keep device name
      alias: annexSettings.getSettings().alias, // keep alias
      icon: 'computer',
      color: 'indigo',
      autoReconnect: true,
    });'''
new_purge = '''    await annexSettings.updateSettings((current) => ({
      enableServer: false,
      enableClient: false,
      deviceName: current.deviceName, // actual committed preference only
      alias: current.alias,
      icon: 'computer',
      color: 'indigo',
      autoReconnect: true,
    }), true);'''
assert s.count(old_purge) == 1
s = s.replace(old_purge, new_purge)
old_rename = """    (_event, fingerprint, name) => membership.renameMember(fingerprint, name),"""
new_rename = """    (event, fingerprint, name) => {
      const admittedGeneration = emergencyGeneration;
      const assertUiAuthorized = captureNameUiAuthority(event);
      const assertAuthorized = () => {
        assertUiAuthorized();
        if (admittedGeneration !== emergencyGeneration) throw new NameMutationFailure('superseded');
      };
      const rename = async () => {
        assertAuthorized();
        const renamed = await membership.renameMember(fingerprint, name, assertAuthorized);
        assertAuthorized();
        return renamed;
      };
      return rename();
    },"""
assert s.count(old_rename) == 1
s = s.replace(old_rename, new_rename)
new[p] = s
p = paths[3]
s = new[p]
s = s.replace("import { registerGlobalTool } from '../tool-registry';", """import { registerGlobalTool, callGrantIsApproved, grantApprovalContext } from '../tool-registry';
import { checkToolGrant } from '../grant-check';
import { mcpCallAccess } from '../mcp-call-gate';
import { agentRegistry } from '../../agent-registry';
import { callApprovalVersion } from '../../grant-requests';""")
s = s.replace('rename(fingerprint: string, name: string): boolean | Promise<boolean>;', 'rename(fingerprint: string, name: string, assertAuthorized: () => void): boolean | Promise<boolean>;')
s = s.replace("const NOT_FOUND =", "const RENAME_GRANT = { actions: ['device.manage'], target: 'app' } as const;\n\nconst NOT_FOUND =")
old_call = """      const ok = await host.rename(device.fingerprint, name);
      appLog('core:annex', 'info', 'An agent renamed a device', { meta: { agentId, ok } });
      return ok ? text(`Renamed it to ${name}.`) : text('It could not be renamed. It may have left the network.', true);
    },
    { grant: { actions: ['device.manage'], target: 'app' } },"""
new_call = """      const selectedHost = host;
      const registration = agentRegistry.get(agentId);
      const nonce = registration?.nonce;
      const approvalVersion = callApprovalVersion(agentId);
      const targets = new Map(); // app target has no argument-target resolution
      const context = grantApprovalContext(agentId, 'rename_device', args, RENAME_GRANT, targets);
      const assertAuthorized = () => {
        if (!registration || agentRegistry.get(agentId) !== registration || registration.nonce !== nonce
          || mcpCallAccess(agentId, registration.projectPath) !== 'open' || host !== selectedHost
          || callApprovalVersion(agentId) !== approvalVersion) throw new Error('Device rename caller changed.');
        const currentContext = grantApprovalContext(agentId, 'rename_device', args, RENAME_GRANT, targets);
        const check = checkToolGrant(agentId, RENAME_GRANT, args, undefined, targets);
        if (currentContext !== context || !callGrantIsApproved(agentId, 'rename_device', args, check, currentContext)) {
          throw new Error('Device rename permission changed.');
        }
        // Membership captures/rechecks raw target pin/pairing/epoch separately.
      };
      try {
        assertAuthorized();
        const ok = await selectedHost.rename(device.fingerprint, name, assertAuthorized);
        assertAuthorized();
        appLog('core:annex', 'info', 'An agent renamed a device', { meta: { agentId, ok } });
        return ok ? text(`Renamed it to ${name}.`) : text('It could not be renamed. It may have left the network.', true);
      } catch {
        appLog('core:annex', 'info', 'An agent device rename was refused or unconfirmed', { meta: { agentId } });
        return text('The device rename was refused or could not be confirmed. Read the current name before trying again.', true);
      }
    },
    { grant: RENAME_GRANT },"""
assert s.count(old_call) == 1
s = s.replace(old_call, new_call)
new[p] = s
p = paths[4]
s = new[p]
s = s.replace("import { configurePluginMcpHost } from './ipc/plugin-mcp-handlers';", """import { configurePluginMcpHost } from './ipc/plugin-mcp-handlers';
// REVIEW ONLY: distinct name-UI authority, not a plugin token issuer.
import { configureAnnexNameUiHost } from './ipc/annex-name-ui-authority';""")
needle = """  markStartup('register_ipc_end');"""
assert s.count(needle) == 1
s = s.replace(needle, """  configureAnnexNameUiHost({
    getMainWindow: () => mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    entryUrl: MAIN_WINDOW_WEBPACK_ENTRY,
  });
""" + needle)
new[p] = s
# Bind the host callback from MCP to the membership authority seam.
p = paths[2]
new[p] = new[p].replace('rename: (fingerprint, name) => membership.renameMember(fingerprint, name),', 'rename: (fingerprint, name, assertAuthorized) => membership.renameMember(fingerprint, name, assertAuthorized),')
patch = ''.join(''.join(difflib.unified_diff(old[p].splitlines(True), new[p].splitlines(True), fromfile='a/'+p, tofile='b/'+p, n=0)) for p in paths)
(ROOT/'committed-composition.review.patch').write_text(patch)
(ROOT/'source-binding.json').write_text(json.dumps({
 'status': 'UNAPPLIED UNEXECUTED review-only sketch; membership/UI helper APIs are proposed, not implemented; shared hunks not cleared',
 'sourceCommit': BASE,
 'sha256': {p: hashlib.sha256(old[p].encode()).hexdigest() for p in paths},
 'patch': 'committed-composition.review.patch',
 'rejectedHistoricalSketch': 'unsafe-precondition-only.review.patch.json',
 'rejectedHistoricalSketchSource': 'be29c82a5eba1003d06a992209f6536506062b64',
 'sourceEquality': 'All five patch inputs identical between be29 and50cb; no runtime proof transfers.',
}, indent=2)+'\n')
print('Generated unapplied review patch from exact git objects; no product files written.')
