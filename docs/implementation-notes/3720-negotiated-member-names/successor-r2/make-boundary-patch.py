"""Generate UNAPPLIED source-contract boundary hunks. Never writes product files.
Transaction/session helper implementations are explicitly absent, not compile proof.
"""
from pathlib import Path
import subprocess, difflib, hashlib, json
root=Path(__file__).resolve().parent
base='50cb77ab6ccf9f383a39e59db308f4f8336051ea'
paths=['src/main/services/launch-gate.ts','src/main/services/clubhouse-mcp/tools/annex-network-tools.ts','src/preload/annex.ts','src/renderer/stores/annexStore.ts','src/renderer/features/settings/AnnexNetworkSettingsView.tsx','src/renderer/features/settings/AnnexIdentitySection.tsx','src/renderer/features/command-palette/use-command-source.ts','src/main/ipc/annex-handlers.ts']
old={p:subprocess.check_output(['git','show',base+':'+p]).decode() for p in paths}
new=old.copy()
p=paths[0];s=new[p]
s=s.replace('let closedFor: string | null = null;', 'let closedFor: string | null = null;\n// REVIEW ONLY: additive observation for opted-in Annex callers.\nlet admissionGeneration = Symbol();')
s=s.replace('export function closeLaunches(reason: string): void {\n  closedFor = reason;', 'export function closeLaunches(reason: string): void {\n  admissionGeneration = Symbol(); // rotate on EVERY close, including already closed\n  closedFor = reason;')
needle='export function assertLaunchesOpen(): void {'
assert needle in s
s=s.replace(needle, '''/** Observation only; no cancellation, drain, grant or launch authority. */
export function captureLaunchAdmission(): () => boolean {
  const generation = admissionGeneration;
  const wasOpen = launchesOpen();
  return () => wasOpen && generation === admissionGeneration && launchesOpen();
}

'''+needle)
new[p]=s
p=paths[1];s=new[p]
s=s.replace('export interface AnnexNetworkToolHost {', '''/** REVIEW ONLY: invocation-local capability to observe admission, not approve a grant. */
export interface AnnexRuntimeAdmission {
  assertCurrent(): void;
  dispose(): void;
}
export interface AnnexLoopbackContext {
  admission: AnnexRuntimeAdmission;
  assertAuthorized(): void;
  assertExpectedState(): void;
}
export interface AnnexNetworkToolHost {''')
s=s.replace('  applyLoopbackOnly(value: boolean, assertAuthorized: () => void): Promise<void>;', '  captureRuntimeAdmission(): AnnexRuntimeAdmission;\n  applyLoopbackOnly(value: boolean, context: AnnexLoopbackContext): Promise<void>;')
needle='    const loopbackOnly = args.loopback_only;'
assert s.count(needle)==1
s=s.replace(needle, '''    // Original installed host + admission captured BEFORE queue or Ask await.
    const installedHost = host;
    if (!installedHost) return text('Annex Network is not available.', true);
    const admission = installedHost.captureRuntimeAdmission();
    const assertAuthorized = () => {
      if (host !== installedHost) throw new Error('Annex host changed; submit a new invocation.');
      admission.assertCurrent();
      assertGrant(agentId, args); // original grant, never replaced by admission
    };
'''+needle)
s=s.replace('        assertGrant(agentId, args);', '        assertAuthorized();')
s=s.replace("        if (!host) throw new Error('Annex Network settings are not available.');", '        assertAuthorized(); // preAsk')
old_call='''        await host.applyLoopbackOnly(loopbackOnly, () => {
          assertAuthorized();
          if (readAnnexNetworkSettings().expected_state !== args.expected_state) throw new Error('Annex Network settings changed before the write.');
        });'''
# The earlier replacement changes only 8-space occurrences; the nested one remains.
assert old_call in s
s=s.replace(old_call, '''        await installedHost.applyLoopbackOnly(loopbackOnly, {
          admission,
          assertAuthorized,
          // Only before forward commit. After it, use the exact owned receipt.
          assertExpectedState: () => {
            if (readAnnexNetworkSettings().expected_state !== args.expected_state) throw new Error('Annex Network settings changed before the write.');
          },
        });
        assertAuthorized();''')
s=s.replace('    return pending;\n  }, { grant: WRITE_GRANT });', '    return pending.finally(() => admission.dispose());\n  }, { grant: WRITE_GRANT });')
new[p]=s
p=paths[2];s=new[p]
s=s.replace("import type { AnnexAgentUpdate }", "import type { CommittedAnnexSettings, LocalSettingsPatch, LocalSettingsResult } from '../shared/annex-settings-ipc';\nimport type { AnnexAgentUpdate }")
s=s.replace('  getSettings: () =>\n', '  getSettings: (): Promise<CommittedAnnexSettings> =>\n',1)
a=s.index('  saveSettings: (settings:');b=s.index('  getStatus:',a)
s=s[:a]+'''  saveSettings: (request: LocalSettingsPatch): Promise<LocalSettingsResult> =>
    ipcRenderer.invoke(IPC.ANNEX.SAVE_SETTINGS, request),
'''+s[b:]
new[p]=s
p=paths[3];s=new[p]
s=s.replace("import { create } from 'zustand';", """import { create } from 'zustand';
import type { CommittedAnnexSettings, LocalSettingsEdit, LocalSettingsResult } from '../../shared/annex-settings-ipc';
// REVIEW ONLY: proposed session helper, not implemented by this boundary sketch.
import { createAnnexSettingsSession } from './annexSettingsCommitSession';
const settingsSession = createAnnexSettingsSession();""")
s=s.replace('  saveSettings: (settings: AnnexSettings) => Promise<void>;', '  saveSettings: (edit: LocalSettingsEdit) => Promise<LocalSettingsResult>;\n  settingsSnapshot: CommittedAnnexSettings | null;\n  settingsError: string | null;')
s=s.replace('  settings: DEFAULT_SETTINGS,', '  settings: DEFAULT_SETTINGS,\n  settingsSnapshot: null,\n  settingsError: null,',1)
s=s.replace('''      set({
        settings: settings || DEFAULT_SETTINGS,
        status: status || DEFAULT_STATUS,
      });''', '''      // Session enforces generation/load ordering and committed revision only.
      settingsSession.acceptLoad(settings, (snapshot) => set({ settings: snapshot.settings, settingsSnapshot: snapshot }));
      set({ status: status || DEFAULT_STATUS });''',1)
a=s.index('  saveSettings: async (settings: AnnexSettings) => {');b=s.index('  loadStatus: async () => {',a)
s=s[:a]+'''  saveSettings: async (edit: LocalSettingsEdit) => settingsSession.submit(edit, {
    read: () => window.clubhouse.annex.getSettings(),
    send: (request) => window.clubhouse.annex.saveSettings(request),
    accept: (snapshot) => set({ settings: snapshot.settings, settingsSnapshot: snapshot }),
    error: (message) => set({ settingsError: message }),
  }),

'''+s[b:]
s=s.replace('  loadSettings: async () => {\n    try {', '  loadSettings: async () => {\n    const load = settingsSession.beginLoad();\n    try {',1)
s=s.replace('settingsSession.acceptLoad(settings,', 'settingsSession.acceptLoad(load, settings,',1)
s=s.replace('  purgeServerConfig: async () => {\n    try {', '  purgeServerConfig: async () => {\n    settingsSession.invalidateForReset(); // BEFORE any await; drafts never become settings\n    try {',1)
s=s.replace('''      const settings = await window.clubhouse.annex.getSettings();
      set({ settings: settings ? { ...DEFAULT_SETTINGS, ...settings } : DEFAULT_SETTINGS });''', '''      const load = settingsSession.beginLoad();
      const settings = await window.clubhouse.annex.getSettings();
      settingsSession.acceptLoad(load, settings, (snapshot) => set({ settings: snapshot.settings, settingsSnapshot: snapshot }));''')
# Do not silently swallow settings load/purge outcomes in the proposed boundary.
s=s.replace('''    } catch {
      // Keep defaults
    }
  },

  saveSettings:''', '''    } catch {
      settingsSession.failLoad(load);
      set({ settingsError: 'Saved Annex settings could not be read.' });
    }
  },

  saveSettings:''',1)
new[p]=s
p=paths[4];s=new[p]
s=s.replace("import type { AnnexSettings } from '../../../shared/types';", "import type { LocalSettingsEdit } from '../../../shared/annex-settings-ipc';")
a=s.index('  // Built on what main has saved,');b=s.index('  const pairAgainHere',a)
s=s[:a]+'''  // Explicit keys only. The store reads a committed versioned baseline.
  const saveCurrentSettings = async (changes: LocalSettingsEdit['changes']): Promise<void> => {
    const result = await saveSettings({ origin: 'network-settings', changes, unset: [] });
    setSettingsLoadFailed(result.outcome !== 'committed');
  };
  const setOn = (value: boolean): Promise<void> =>
    saveCurrentSettings({ enableServer: value, enableClient: value, ...(value && { networkEnabled: true }) });
'''+s[b:]
s=s.replace('saveSettings({ ...settings, deviceName: e.target.value })', "saveSettings({ origin: 'network-settings', changes: { deviceName: e.target.value }, unset: [] })")
s=s.replace('saveSettings({ ...settings, reachableAs: e.target.value })', "saveSettings({ origin: 'network-settings', changes: { reachableAs: e.target.value }, unset: [] })")
# Draft UI wiring remains explicit review helper work, not a claim this onChange view is complete.
s=s.replace('value={settings.deviceName}', "value={settingsSessionDraft('deviceName', settings.deviceName)}")
s=s.replace('value={settings.reachableAs ?? \'\'}', "value={settingsSessionDraft('reachableAs', settings.reachableAs ?? '')}")
s=s.replace("import type { LocalSettingsEdit }", "// REVIEW ONLY: draft getter/explicit-save wiring contract remains unapplied.\nimport { settingsSessionDraft } from '../../stores/annexSettingsCommitSession';\nimport type { LocalSettingsEdit }")
new[p]=s
p=paths[5];s=new[p]
s=s.replace("import type { AnnexSettings, AnnexStatus }", "import type { LocalSettingsEdit, LocalSettingsResult } from '../../../shared/annex-settings-ipc';\nimport { settingsSessionDraft } from '../../stores/annexSettingsCommitSession';\nimport type { AnnexSettings, AnnexStatus }")
s=s.replace('onSave: (settings: AnnexSettings) => void;', 'onSave: (edit: LocalSettingsEdit) => Promise<LocalSettingsResult>;')
s=s.replace('value={settings.alias}', "value={settingsSessionDraft('alias', settings.alias)}")
s=s.replace('onSave({ ...settings, alias: e.target.value })', "onSave({ origin: 'identity', changes: { alias: e.target.value }, unset: [] })")
s=s.replace('onSave({ ...settings, color: color.id })', "onSave({ origin: 'identity', changes: { color: color.id }, unset: [] })")
new[p]=s
p=paths[6];s=new[p]
s=s.replace('useAnnexStore.getState().saveSettings({ ...annexSettings, enableServer: !annexSettings.enableServer });', "const current = useAnnexStore.getState().settings;\n        void useAnnexStore.getState().saveSettings({ origin: 'command-palette', changes: { enableServer: !current.enableServer }, unset: [] });")
s=s.replace('useAnnexStore.getState().saveSettings({ ...annexSettings, enableClient: !annexSettings.enableClient });', "const current = useAnnexStore.getState().settings;\n        void useAnnexStore.getState().saveSettings({ origin: 'command-palette', changes: { enableClient: !current.enableClient }, unset: [] });")
new[p]=s
p=paths[7];s=new[p]
s=s.replace("import { deliveryHash } from '../services/annex-delivery-store';", """import { deliveryHash } from '../services/annex-delivery-store';
import { readLocalSettingsPatch } from '../../shared/annex-settings-ipc';
// REVIEW ONLY: transaction APIs specified in contract.md, not implemented here.
import { captureAnnexRuntimeAdmission, applyLocalSettingsTransaction, applyLoopbackTransaction, beginAnnexEmergency } from './annex-settings-transaction';""")
a=s.index('    applyLoopbackOnly: async (value, assertAuthorized) => {');b=s.index('\n  });',a)
s=s[:a]+'''    captureRuntimeAdmission: captureAnnexRuntimeAdmission,
    applyLoopbackOnly: (value, context) => applyLoopbackTransaction(value, context, {
      // Helper must check original admission/grant and exact owned commit at
      // every effect, including stale STOP/catch/restore, as contract specifies.
      server: annexServer,
      client: annexClient,
      settingsChanged: () => settingsChanged('annex'),
      broadcastStatusChanged,
    }),'''+s[b:]
s=s.replace('    return annexSettings.getSettings();\n  });\n\n  let settingsWrites:', '    return annexSettings.getSettingsSnapshot();\n  });\n\n  let settingsWrites:',1)
a=s.index('  ipcMain.handle(IPC.ANNEX.SAVE_SETTINGS, withValidatedArgs(');b=s.index('\n  ipcMain.handle(IPC.ANNEX.GET_STATUS',a)
s=s[:a]+'''  ipcMain.handle(IPC.ANNEX.SAVE_SETTINGS, (event, raw: unknown) => {
    const request = readLocalSettingsPatch(raw); // strict validate + one clone
    const admission = captureAnnexRuntimeAdmission(); // request ENTRY, not queued callback
    const apply = () => applyLocalSettingsTransaction(event, request, admission, {
      applyNetworkSettings, settingsChanged: () => settingsChanged('annex'),
    });
    const saved = settingsWrites.then(apply, apply);
    settingsWrites = saved.then(() => undefined, () => undefined);
    return saved.finally(() => admission.dispose());
  });
'''+s[b:]
s=s.replace('  ipcMain.handle(IPC.ANNEX.DISABLE_AND_DISCONNECT, async () => {\n    annexServer.stop();', '  ipcMain.handle(IPC.ANNEX.DISABLE_AND_DISCONNECT, async () => {\n    beginAnnexEmergency(); // generation BEFORE existing immediate stop; no IO\n    annexServer.stop();')
s=s.replace('    // Stop everything first\n    annexServer.stop();', '    beginAnnexEmergency({ resetSettingsEpoch: true }); // rotate random epoch BEFORE stop\n    // Stop everything first\n    annexServer.stop();')
new[p]=s
# New local-only DTO/validator. No AnnexSettings/member-wire/mobile schema changes.
new_path='src/shared/annex-settings-ipc.ts'
new[new_path]='''/** REVIEW ONLY: local IPC contract. Not a wire/mobile or authority token. */
import type { AnnexSettings } from './types';
export const EDITABLE_KEYS = ['enableServer','enableClient','loopbackOnly','deviceName','alias','icon','color','autoReconnect','reachableAs','networkEnabled','acceptHandoffs'] as const;
export type EditableKey = typeof EDITABLE_KEYS[number];
export type OptionalEditableKey = 'loopbackOnly'|'reachableAs'|'networkEnabled'|'acceptHandoffs';
export type LocalOrigin = 'identity'|'network-settings'|'command-palette';
export interface LocalSettingsEdit { origin: LocalOrigin; changes: Partial<Pick<AnnexSettings, EditableKey>>; unset: OptionalEditableKey[] }
export interface CommittedAnnexSettings { v: 1; epoch: string; revision: number; fields: Record<EditableKey, number>; settings: AnnexSettings }
export interface LocalSettingsPatch extends LocalSettingsEdit { v: 1; requestId: string; base: { epoch: string; revision: number; fields: Partial<Record<EditableKey, number>> } }
export interface LocalSettingsResult { v: 1; requestId: string; outcome: 'committed'|'refused'|'committed_unconfirmed'; code: string; snapshot?: CommittedAnnexSettings }
const optional = new Set<string>(['loopbackOnly','reachableAs','networkEnabled','acceptHandoffs']);
const booleans = new Set<string>(['enableServer','enableClient','loopbackOnly','autoReconnect','networkEnabled','acceptHandoffs']);
const limits: Record<string, number> = { deviceName: 200, alias: 200, icon: 128, color: 128, reachableAs: 1024 };
const origins: Record<LocalOrigin, readonly string[]> = {
  identity: ['alias','color','icon'],
  'network-settings': ['enableServer','enableClient','loopbackOnly','deviceName','autoReconnect','reachableAs','networkEnabled','acceptHandoffs'],
  'command-palette': ['enableServer','enableClient'],
};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const version = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
function object(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) return false;
  return Reflect.ownKeys(v).every((key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(v,key)!);
}
const exact = (v: Record<string,unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v,key));
function wellFormed(s: string): boolean {
  for (let i=0;i<s.length;i++) {
    const c=s.charCodeAt(i);
    if (c>=0xd800&&c<=0xdbff) { const d=s.charCodeAt(++i); if (!(d>=0xdc00&&d<=0xdfff)) return false; }
    else if (c>=0xdc00&&c<=0xdfff) return false;
  }
  return true;
}
export function readLocalSettingsPatch(raw: unknown): LocalSettingsPatch {
  const fail = (): never => { throw new Error('Invalid local Annex settings patch.'); };
  if (!object(raw) || !exact(raw,['v','requestId','origin','base','changes','unset']) || raw.v!==1 || !uuid(raw.requestId)
    || typeof raw.origin!=='string' || !Object.hasOwn(origins,raw.origin) || !object(raw.base) || !exact(raw.base,['epoch','revision','fields'])
    || !uuid(raw.base.epoch) || !version(raw.base.revision) || !object(raw.base.fields) || !object(raw.changes) || !Array.isArray(raw.unset)) return fail();
  const touched=[...Object.keys(raw.changes),...raw.unset];
  if (!touched.length || touched.length>EDITABLE_KEYS.length || new Set(touched).size!==touched.length
    || touched.some((k) => typeof k!=='string'||!EDITABLE_KEYS.includes(k as EditableKey))
    || raw.unset.some((k) => !optional.has(k)) || !exact(raw.base.fields,touched as string[])
    || Object.values(raw.base.fields).some((v) => !version(v)||v>raw.base.revision)) return fail();
  const origin=raw.origin as LocalOrigin;
  if (touched.some((k) => !origins[origin].includes(k)) || origin==='command-palette'&&touched.length!==1) return fail();
  for (const [key,value] of Object.entries(raw.changes)) {
    if (booleans.has(key) ? typeof value!=='boolean' : typeof value!=='string'||value.length>limits[key]||!wellFormed(value)) return fail();
  }
  if (new TextEncoder().encode(JSON.stringify(raw)).length>8192) return fail();
  return structuredClone(raw) as unknown as LocalSettingsPatch;
}
'''
# This is boundary review material; missing helpers are explicitly disclosed in README.
patch=''.join(''.join(difflib.unified_diff(old.get(p,'').splitlines(True),new[p].splitlines(True),fromfile='a/'+p if p in old else '/dev/null',tofile='b/'+p,n=0)) for p in new)
(root/'boundaries.review.patch').write_text(patch)
p=paths[0]
(root/'launch-gate.review.patch').write_text(''.join(difflib.unified_diff(old[p].splitlines(True),new[p].splitlines(True),fromfile='a/'+p,tofile='b/'+p,n=0)))
(root/'source-binding.json').write_text(json.dumps({'status':'UNAPPLIED UNEXECUTED boundary-only source contract; transaction/session/version implementations not supplied; NOT apply-ready production patch','sourceCommit':base,'sha256':{p:hashlib.sha256(old[p].encode()).hexdigest() for p in paths},'newFile':new_path,'patch':'boundaries.review.patch','retainedR1':'379ebdca083d28634e497279ad9e4e0fd08bd3e1'},indent=2)+'\n')
print('Generated exact boundary review hunks; no product files written or executed.')
