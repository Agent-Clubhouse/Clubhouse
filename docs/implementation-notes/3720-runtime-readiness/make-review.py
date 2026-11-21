"""Build/check an unapplied source-contract patch. Never mutates product code."""
from pathlib import Path
import datetime,difflib,hashlib,json,subprocess

root=Path(__file__).resolve().parent
repo=root.parents[2]
base='b02542b5cf3cac51a3aada5919dd5b6c43757a9e'
paths=['src/main/services/annex-server.ts','src/main/ipc/annex-handlers.ts',
       'src/main/services/annex-client.ts','src/main/services/annex-settings.ts',
       'src/main/services/annex-network-profile.ts',
       'src/main/services/clubhouse-mcp/tools/annex-network-tools.ts',
       'src/main/services/launch-gate.ts','src/main/services/app-shutdown.ts',
       'src/main/shutdown-guard.ts','src/main/index.ts']
hashes={}
for name in paths:
    actual=(repo/name).read_bytes()
    assert actual==subprocess.check_output(['git','show',base+':'+name],cwd=repo),name
    hashes[name]=hashlib.sha256(actual).hexdigest()
server=paths[0]
before=(repo/server).read_text()
anchor='function startServer(strict = false): Promise<void> {'
assert before.count(anchor)==1
additions=(root/'secure-listener-functions.review.ts.txt').read_text()
after=before.replace(anchor,additions+'\n'+anchor)
patch=''.join(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/'+server,tofile='b/'+server))
(root/'secure-listener.review.patch.json').write_text(json.dumps({'status':'UNAPPLIED REVIEW ONLY; not build/runtime proof','base':base,'sourceSHA256':hashes[server],'patch':patch,'patchSHA256':hashlib.sha256(patch.encode()).hexdigest()},indent=2)+'\n')
cache=repo/'.cache/3720-runtime';cache.mkdir(parents=True,exist_ok=True)
patch_path=cache/'secure-listener.review.patch';patch_path.write_text(patch)
argv=['git','apply','--check',str(patch_path.relative_to(repo))]
result=subprocess.run(argv,cwd=repo,text=True,capture_output=True)
receipt={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
         'headAtCheck':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
         'base':base,'argv':argv,'actualExit':result.returncode,'stdout':result.stdout,'stderr':result.stderr,
         'sourceSHA256Before':hashes,'sourceSHA256After':{p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in paths},
         'patchSHA256':hashlib.sha256(patch.encode()).hexdigest(),
         'generatorSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
(root/'patch-check.json').write_text(json.dumps(receipt,indent=2)+'\n')
assert result.returncode==0 and receipt['sourceSHA256Before']==receipt['sourceSHA256After']
patterns={
 'runtime-callers.txt':r'(annexServer|annexClient)\.(startVerified|start|stop|startClient|stopClient|scan)\(',
 'launch-callers.txt':r'closeLaunches\(|reopenLaunches\(|captureLaunchAdmission\(|assertLaunchesOpen\(|runAgentWork\(|closeAgentWork\(|agentWorkOpen\(',
 'server-lifecycle-sites.txt':r'serverGeneration|boundHost|export (async )?function (start|stop|startVerified)|server\.close\(',
}
for filename,pattern in patterns.items():
    scope=['src/main/services/annex-server.ts'] if filename.startswith('server-') else ['src/main']
    args=['rg','-n',pattern,*scope,'--glob','!*.test.ts']
    found=subprocess.run(args,cwd=repo,text=True,capture_output=True)
    assert found.returncode==0,(filename,found.stderr)
    (root/filename).write_text(found.stdout)
(root/'source-binding.json').write_text(json.dumps({'base':base,'sourceSHA256':hashes,'status':'Source-only caller inventory and unapplied patch; no product/runtime execution'},indent=2)+'\n')
print('Unapplied patch applicability passed; 10 source files unchanged. No product code applied or executed.')
