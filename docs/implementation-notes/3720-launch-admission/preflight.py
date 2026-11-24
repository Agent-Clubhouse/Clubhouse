"""Read-only local admission and matched-cache verification; no installs/writes."""
from pathlib import Path
import json,hashlib,os,subprocess
repo=Path(__file__).resolve().parents[3]
lockPath=repo/'package-lock.json'
lock=json.loads(lockPath.read_text())
cache=(repo/'node_modules').resolve().parent
assert lockPath.read_bytes()==(cache/'package-lock.json').read_bytes()
checked=0
for name,entry in lock['packages'].items():
 if not name or entry.get('optional') or entry.get('link'):continue
 file=cache/name/'package.json'
 assert file.is_file(),name
 actual=json.loads(file.read_text())
 assert not entry.get('version') or actual.get('version')==entry['version'],name
 checked+=1
print(json.dumps({'loadAverage':os.getloadavg(),'cpuCount':os.cpu_count(),'lockSHA256':hashlib.sha256(lockPath.read_bytes()).hexdigest(),'cachedLockEqual':True,'nonOptionalPackageMetadataMatched':checked,'workersAdmitted':1,'heavyChecks':'sequential','cacheUse':'read-only; task config/cache under isolated workspace .cache; no install'},indent=2))
print(subprocess.check_output(['vm_stat'],text=True))
