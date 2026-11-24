"""Run one explicit proof command, preserving actual HEAD/source/argv/output/exit.
No install, app/agent runtime launch, or shared dependency-cache write.
"""
from pathlib import Path
import subprocess,json,hashlib,datetime,os,sys
root=Path(__file__).resolve().parent
repo=root.parents[2]
label,expected,*argv=sys.argv[1:]
if not argv:raise SystemExit('usage: run-proof.py LABEL EXPECTED_EXIT COMMAND ...')
inputs=['src/main/services/launch-gate.ts','src/main/services/launch-gate.test.ts','src/main/services/app-shutdown.ts','src/main/services/app-shutdown.test.ts','src/main/shutdown-guard.ts','vitest.config.ts','test/global-setup.ts','test/standard-runtime-boundary.ts','package-lock.json']
config=repo/'.cache/3720-launch/vitest.config.ts'
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
hashes={p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in inputs}
if config.exists():hashes[str(config.relative_to(repo))]=hashlib.sha256(config.read_bytes()).hexdigest()
env=os.environ.copy();env['NODE_DISABLE_COMPILE_CACHE']='1';env['FORCE_COLOR']='0'
r=subprocess.run(argv,cwd=repo,env=env,text=True,capture_output=True)
raw=root/'evidence'/(label+'.txt')
raw.write_text('HEAD: '+head+'\nCommand argv: '+json.dumps(argv)+'\nStart UTC: '+start+'\nExit code: '+str(r.returncode)+'\nSTDOUT:\n'+r.stdout+'\nSTDERR:\n'+r.stderr)
receipt={'label':label,'headAtExecution':head,'startedAtUTC':start,'endedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'argv':argv,'expectedExitCode':int(expected),'actualExitCode':r.returncode,'inputSHA256':hashes,'sourceDiff':subprocess.check_output(['git','diff','--',*inputs],cwd=repo,text=True),'rawOutput':raw.name,'rawSHA256':hashlib.sha256(raw.read_bytes()).hexdigest(),'inputSHA256After':{p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in hashes},'runnerSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'environmentOverrides':{'NODE_DISABLE_COMPILE_CACHE':'1','FORCE_COLOR':'0'}}
(root/'evidence'/(label+'.json')).write_text(json.dumps(receipt,indent=2)+'\n')
print(label+': actual exit '+str(r.returncode)+' (expected '+expected+')')
print(r.stdout[-5000:]);print(r.stderr[-4000:])
if r.returncode!=int(expected) or any(receipt['inputSHA256After'][p]!=h for p,h in hashes.items()):raise SystemExit(1)
