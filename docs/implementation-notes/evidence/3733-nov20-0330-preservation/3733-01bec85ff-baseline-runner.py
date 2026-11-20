from pathlib import Path
import subprocess,json,hashlib
r=Path('/Users/masonallen/source/Clubhouse/.clubhouse/qa-reports');p='3733-01bec85ff-page-envelope-baseline';out=r/f'{p}-driver-stdout.log'
with out.open('w') as f:result=subprocess.run(['python3',str(r/'3733-01bec85ff-baseline-driver.py')],stdout=f,stderr=subprocess.STDOUT)
receipt=r/f'{p}-driver-result.json';receipt.write_text(json.dumps({'driverExit':result.returncode,'expectedFailingTestsNotProductPass':True,'stdoutSHA256':hashlib.sha256(out.read_bytes()).hexdigest()},indent=2)+'\n');assert result.returncode==0
m=json.loads((r/f'{p}-initial-manifest.json').read_text());m['files'].update({x.name:hashlib.sha256(x.read_bytes()).hexdigest() for x in [out,receipt,Path(__file__),r/f'{p}-initial-manifest.json']});file=r/f'{p}-manifest.json';file.write_text(json.dumps(m,indent=2)+'\n');print('SEALED_EXPECTED_FAILURE',len(m['files']),hashlib.sha256(file.read_bytes()).hexdigest(),flush=True)
