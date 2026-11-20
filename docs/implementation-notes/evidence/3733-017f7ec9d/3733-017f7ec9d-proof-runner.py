from pathlib import Path
import datetime,subprocess,json,hashlib
r=Path('/Users/masonallen/source/Clubhouse/.clubhouse/qa-reports');p='3733-017f7ec9d';start=datetime.datetime.now(datetime.timezone.utc).isoformat();out=r/f'{p}-driver.log'
with out.open('w') as stream:
 stream.write(json.dumps({'startedAt':start,'command':['python3',str(r/f'{p}-proof-driver.py'),str(r/f'{p}-configuration.json')]})+'\n');stream.flush()
 result=subprocess.run(['python3',str(r/f'{p}-proof-driver.py'),str(r/f'{p}-configuration.json')],stdout=stream,stderr=subprocess.STDOUT)
 stream.write('\n'+json.dumps({'driverExit':result.returncode,'endedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})+'\n')
receipt=r/f'{p}-driver-result.json';receipt.write_text(json.dumps({'driverExit':result.returncode,'stdoutFile':out.name,'stdoutSHA256':hashlib.sha256(out.read_bytes()).hexdigest(),'startedAt':start,'endedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
initial=r/f'{p}-initial-manifest.json'
if initial.is_file():
 manifest=json.loads(initial.read_text());paths=[r/n for n in manifest['requiredArtifacts']]+[initial,out,receipt]
 manifest.update({'requiredArtifacts':[f.name for f in paths],'files':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in paths},'driverExit':result.returncode})
 (r/f'{p}-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('DRIVER_EXIT',result.returncode,'STDOUT',out,flush=True)
raise SystemExit(result.returncode)
