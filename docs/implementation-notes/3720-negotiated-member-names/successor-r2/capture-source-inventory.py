"""Capture actual read-only source inventories; no product code is executed."""
from pathlib import Path
import subprocess,json,hashlib
root=Path(__file__).resolve().parent
base='50cb77ab6ccf9f383a39e59db308f4f8336051ea'
queries={
 'caller-inventory': ['git','grep','-n','saveSettings\\|getSettings\\|onSave',base,'--','src/preload/annex.ts','src/renderer/stores/annexStore.ts','src/renderer/features/settings/AnnexNetworkSettingsView.tsx','src/renderer/features/settings/AnnexIdentitySection.tsx','src/renderer/features/command-palette/use-command-source.ts'],
 'all-local-save-callers': ['git','grep','-n','-E',r'annex\.saveSettings|useAnnexStore.*saveSettings',base,'--','src',':!*.test.ts',':!*.test.tsx'],
 'launch-callers': ['git','grep','-n','-E',r'(closeLaunches|reopenLaunches|launchesOpen|assertLaunchesOpen|closeAgentWork|agentWorkOpen|assertAgentWorkOpen|whenAgentWorkOpen|runAgentWork|runAppShutdown|cancelAppShutdown|stopClient|retryControl)\(',base,'--','src/main',':!*.test.ts'],
 'equivalent-launch-generation-search': ['git','grep','-n','-E',r'launch.*(epoch|generation|receipt)|(generation|epoch).*launch',base,'--','src/main/services/launch-gate.ts','src/main/services/app-shutdown.ts','src/main/shutdown-guard.ts'],
 'store-compatibility-importers': ['git','grep','-n','-E',r'import.*replaceFile|createSettingsStore[<(]',base,'--','src/main',':!*.test.ts'],
 'manual-disabled-paths': ['git','grep','-n','-E',r'retry\(|retryControl\(|startClient\(|stopClient\(|resumeAllConnections\(|DISABLE_AND_DISCONNECT|PURGE_SERVER_CONFIG|enableClient',base,'--','src/main/services/annex-client.ts','src/main/ipc/annex-handlers.ts','src/main/services/clubhouse-mcp/tools/device-tools.ts'],
 'server-lifecycle-callers': ['git','grep','-n','-E',r'annexServer\.(start|startVerified|stop)\(',base,'--','src/main',':!*.test.ts'],
}
rows=[]
for label,command in queries.items():
 r=subprocess.run(command,text=True,capture_output=True)
 p=root/(label+'.txt')
 p.write_text('Source: '+base+'\nCommand argv: '+json.dumps(command)+'\nExit code: '+str(r.returncode)+'\nSTDOUT:\n'+r.stdout+'\nSTDERR:\n'+r.stderr)
 rows.append({'label':label,'command':command,'exitCode':r.returncode,'file':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
 if r.returncode and not(label=='equivalent-launch-generation-search' and r.returncode==1):raise SystemExit(label+' failed')
retained='379ebdca083d28634e497279ad9e4e0fd08bd3e1'
remote=subprocess.check_output(['git','ls-remote','origin','refs/heads/annex-wake-readiness/3720-rename-ordering'],text=True)
retained_path='docs/implementation-notes/3720-negotiated-member-names/successor-r1/SHA256SUMS.txt'
raw=subprocess.check_output(['git','show',retained+':'+retained_path])
(root/'retained-r1-readback.json').write_text(json.dumps({'retainedCommit':retained,'path':retained_path,'sha256':hashlib.sha256(raw).hexdigest(),'remoteReadbackBeforeR2Push':remote,'scope':'Actual git-object/remote readback; old validation not reconstructed'},indent=2)+'\n')
(root/'inventory-manifest.json').write_text(json.dumps({'source':base,'scope':'Source searches only; not product execution or proof migration is implemented','queries':rows},indent=2)+'\n')
print('Captured 7 actual source inventories and retained r1 git-object/remote readback; negative equivalent search exit1 expected.')
