from pathlib import Path
import subprocess,json,hashlib,datetime
r=Path('/Users/masonallen/source/Clubhouse/.clubhouse/qa-reports');p='3733-fee2d0c19';out=r/f'{p}-driver-stdout.log'
with out.open('w') as stream: result=subprocess.run(['python3',str(r/f'{p}-proof-driver.py'),str(r/f'{p}-configuration.json')],stdout=stream,stderr=subprocess.STDOUT)
receipt=r/f'{p}-driver-result.json';receipt.write_text(json.dumps({'driverExit':result.returncode,'stdoutSHA256':hashlib.sha256(out.read_bytes()).hexdigest(),'closedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
assert result.returncode==0
m=json.loads((r/f'{p}-initial-manifest.json').read_text());files=m['files'];files.update({x.name:hashlib.sha256(x.read_bytes()).hexdigest() for x in [out,receipt,r/f'{p}-initial-manifest.json']});m['requiredArtifacts']=list(files);m['files']=files
(r/f'{p}-manifest.json').write_text(json.dumps(m,indent=2)+'\n');print('SEALED',len(files),hashlib.sha256((r/f'{p}-manifest.json').read_bytes()).hexdigest(),flush=True)
