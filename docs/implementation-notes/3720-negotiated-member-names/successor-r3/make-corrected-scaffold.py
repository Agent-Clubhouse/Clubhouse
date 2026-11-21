"""Generate docs-only corrected scaffold from frozen r2 using disposable review copies.
No product/worktree source is written or executed. Missing helpers stay explicit.
"""
from pathlib import Path
import subprocess,tempfile,json,difflib,hashlib
root=Path(__file__).resolve().parent
r2=root.parent/'successor-r2'
binding=json.loads((r2/'source-binding.json').read_text());base='be0091d1676764b0e3300898ab0ad1f135f88a46'
old={p:subprocess.check_output(['git','show',base+':'+p]).decode() for p in binding['sha256']}
for name,raw in old.items():
 assert hashlib.sha256(raw.encode()).hexdigest()==binding['sha256'][name], 'Current source differs from r2: '+name
with tempfile.TemporaryDirectory(prefix='3720-r3-review-copy-') as tmp:
 for name,raw in old.items():
  p=Path(tmp)/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(raw)
 subprocess.run(['git','apply','--unidiff-zero',str(r2/binding['patch'])],cwd=tmp,check=True)
 names=[*old,binding['newFile']]
 new={p:(Path(tmp)/p).read_text() for p in names}
p='src/renderer/stores/annexStore.ts';s=new[p]
s=s.replace('''      settingsSession.acceptLoad(load, settings, (snapshot) => set({ settings: snapshot.settings, settingsSnapshot: snapshot }));
      set({ status: status || DEFAULT_STATUS });''', '''      settingsSession.acceptLoad(load, settings, (snapshot) => set({
        settings: snapshot.settings, settingsSnapshot: snapshot,
        status: status || DEFAULT_STATUS,
      })); // ALL setters inside current load ownership callback''')
s=s.replace('''      settingsSession.failLoad(load);
      set({ settingsError: 'Saved Annex settings could not be read.' });''', '''      settingsSession.failLoad(load, () => set({
        settingsError: 'Saved Annex settings could not be read.',
      })); // stale failure cannot publish an external error setter''')
s=s.replace('''    settingsSession.invalidateForReset(); // BEFORE any await; drafts never become settings''', '''    const resetOwner = settingsSession.invalidateForReset(); // BEFORE any await''')
s=s.replace('''      set({ status: DEFAULT_STATUS, peers: [], devices: [] });''', '''      // Main's current notifications own status/peer/device state; never clear
      // a newer published list or status from an old purge completion.
      if (!settingsSession.isCurrent(resetOwner)) return;''')
s=s.replace('''    } catch {
      // Error handled in main
    }
  },

  loadPeers:''', '''    } catch {
      settingsSession.failReset(resetOwner, () => set({ settingsError: 'Reset could not be confirmed.' }));
    }
  },

  loadPeers:''',1)
new[p]=s
p='src/renderer/features/settings/AnnexNetworkSettingsView.tsx';s=new[p]
s=s.replace("import { settingsSessionDraft } from '../../stores/annexSettingsCommitSession';", "import { settingsSessionDraft, useAnnexSettingsActionOwner } from '../../stores/annexSettingsCommitSession';")
s=s.replace('export function AnnexNetworkSettingsView() {', '''export function AnnexNetworkSettingsView() {
  const actionOwner = useAnnexSettingsActionOwner(); // generation + latest action + mounted lifetime''')
s=s.replace('''    const result = await saveSettings({ origin: 'network-settings', changes, unset: [] });
    setSettingsLoadFailed(result.outcome !== 'committed');''', '''    const owner = actionOwner.begin(); // before await
    const result = await saveSettings({ origin: 'network-settings', changes, unset: [] });
    if (owner.current()) setSettingsLoadFailed(result.outcome !== 'committed');''')
new[p]=s
p='src/main/ipc/annex-handlers.ts';s=new[p]
s=s.replace("import { readLocalSettingsPatch } from '../../shared/annex-settings-ipc';", "import { readLocalSettingsPatch, LocalSettingsInputError } from '../../shared/annex-settings-ipc';\nimport { withSettingsSurface } from '../services/settings-audit';")
s=s.replace('captureAnnexRuntimeAdmission, applyLocalSettingsTransaction, applyLoopbackTransaction, beginAnnexEmergency', 'captureAnnexRuntimeAdmission, captureOriginalAnnexIpcEntry, reportLocalSettingsInputRefusal, applyLocalSettingsTransaction, applyLoopbackTransaction, beginAnnexEmergency')
a=s.index('  ipcMain.handle(IPC.ANNEX.SAVE_SETTINGS, (event, raw: unknown) => {');b=s.index('\n  ipcMain.handle(IPC.ANNEX.GET_STATUS',a)
s=s[:a]+'''  ipcMain.handle(IPC.ANNEX.SAVE_SETTINGS, (event, ...rawArgs: unknown[]) => {
    // Original sender/frame/URL/document/runtime receipt, never recaptured in queue.
    const entry = captureOriginalAnnexIpcEntry(event);
    return withSettingsSurface('ui', undefined, () => {
      try {
        if (rawArgs.length !== 1) throw new LocalSettingsInputError('invalid_envelope');
        const validated = withValidatedArgs(
          [(raw: unknown) => readLocalSettingsPatch(raw)],
          (_originalEvent, request) => {
            // Typed construction detaches checked values once. Entry is immutable.
            const apply = () => applyLocalSettingsTransaction(entry, request, {
              applyNetworkSettings, settingsChanged: () => settingsChanged('annex'),
            });
            const saved = settingsWrites.then(apply, apply);
            settingsWrites = saved.then(() => undefined, () => undefined);
            return saved.finally(() => entry.runtime.dispose());
          },
        );
        return validated(event, rawArgs[0]);
      } catch (error) {
        entry.runtime.dispose();
        // Only fixed-code typed input errors become typed refusals; unexpected
        // errors are not reclassified as proof that no commit happened.
        if (!(error instanceof LocalSettingsInputError)) throw error;
        return reportLocalSettingsInputRefusal(entry, error);
      }
    });
  });
'''+s[b:]
new[p]=s
p=binding['newFile'];s=new[p]
s=s.replace("const optional = new Set<string>(['loopbackOnly','reachableAs','networkEnabled','acceptHandoffs']);\n", '')
s=s.replace("const booleans = new Set<string>(['enableServer','enableClient','loopbackOnly','autoReconnect','networkEnabled','acceptHandoffs']);\n", '')
s=s.replace('requestId: string; outcome:', 'requestId: string | null; outcome:')
a=s.index('function object(v: unknown):');s=s[:a]+(root/'strict-parser-body.review.txt').read_text()
new[p]=s
patch=''.join(''.join(difflib.unified_diff(old.get(p,'').splitlines(True),new[p].splitlines(True),fromfile='a/'+p if p in old else '/dev/null',tofile='b/'+p,n=0)) for p in new)
(root/'corrected-boundaries.review.patch').write_text(patch)
(root/'source-binding.json').write_text(json.dumps({'status':'UNAPPLIED INCOMPLETE scaffold. R2 applied ONLY to disposable review copies for transformation; no product source written/executed. New helpers unimplemented.','sourceCommit':base,'sourceByteEqualTo':binding['sourceCommit'],'retainedR2':'15383280a1bdd7151b07a66e4177eef38d10b40c','reviewCommit':'f8c02a0af7bcf09f0ff64f8778f3e06d1e61cbf2','sha256':binding['sha256'],'newFile':binding['newFile'],'patch':'corrected-boundaries.review.patch','unchangedLaunchPatchSha256':hashlib.sha256((r2/'launch-gate.review.patch').read_bytes()).hexdigest()},indent=2)+'\n')
print('Generated docs-only corrected scaffold on disposable source copies. No product source or parser executed; helper implementations remain missing.')
