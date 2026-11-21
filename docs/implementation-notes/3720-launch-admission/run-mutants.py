"""Temporary task-branch mutants; restore exact source bytes in finally.
Each run preserves HEAD, dirty source diff, source hashes and complete Vitest output.
"""
from pathlib import Path
import subprocess,sys,hashlib,json
root=Path(__file__).resolve().parent
repo=root.parents[2]
path=repo/'src/main/services/launch-gate.ts'
original=path.read_bytes();source=original.decode()
close='export function closeLaunches(reason: string): void {\n  admissionGeneration = Symbol();'
assert source.count(close)==1
mutants={
 '04-no-close-rotation':source.replace(close,'export function closeLaunches(reason: string): void {\n  // MUTANT: no generation rotation'),
 '05-reset-on-reopen':source.replace('let admissionGeneration = Symbol();','let admissionGeneration = Symbol();\nconst initialAdmissionGeneration = admissionGeneration;',1).replace('export function reopenLaunches(): void {','export function reopenLaunches(): void {\n  admissionGeneration = initialAdmissionGeneration;',1),
 '06-missing-open-latch':source.replace('return () => wasOpen && generation === admissionGeneration && launchesOpen();','return () => generation === admissionGeneration && launchesOpen();'),
}
command=['node','node_modules/vitest/vitest.mjs','run','--config','.cache/3720-launch/vitest.config.ts','--configLoader','runner','--project','main','--maxWorkers','1','--no-file-parallelism','src/main/services/launch-gate.test.ts','src/main/services/app-shutdown.test.ts']
summary=[]
try:
 for name,mutated in mutants.items():
  assert mutated!=source
  path.write_text(mutated)
  run=subprocess.run([sys.executable,str(root/'run-proof.py'),name,'1',*command],cwd=repo,text=True,capture_output=True)
  receipt=json.loads((root/'evidence'/(name+'.json')).read_text())
  assert run.returncode==0,(name,run.stdout,run.stderr)
  assert receipt['actualExitCode']==1,name
  summary.append({'label':name,'expectedTestExit':1,'actualTestExit':receipt['actualExitCode'],'sourceSHA256':hashlib.sha256(mutated.encode()).hexdigest(),'receipt':name+'.json'})
  print(name+': behavioral mutant killed (test exit1)',flush=True)
  path.write_bytes(original)
finally:
 path.write_bytes(original)
assert path.read_bytes()==original
(root/'evidence/mutation-summary.json').write_text(json.dumps({'scope':'Utility predicate and real coordinator with mocked drivers; NOT Annex consumer integration','mutants':summary,'restoredSourceSHA256':hashlib.sha256(original).hexdigest()},indent=2)+'\n')
