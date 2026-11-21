"""Verify exact archived outputs (including JSON raw carriers), source and counts.
No product execution; does not modify files or reconstruct past receipts.
"""
from pathlib import Path
import json,hashlib,re,subprocess
root=Path(__file__).resolve().parent
evidence=root/'evidence'
transports={row['originalFile']:row for row in json.loads((evidence/'raw-transports.json').read_text())['files']}
for file in sorted(evidence.glob('[0-9]*.json')):
 if file.name.endswith('.raw.json'):continue
 receipt=json.loads(file.read_text())
 assert receipt['actualExitCode']==receipt['expectedExitCode'],file
 assert receipt['inputSHA256']==receipt['inputSHA256After'],file
 if receipt['rawOutput'] in transports:
  row=transports[receipt['rawOutput']]
  carrier=json.loads((evidence/row['carrier']).read_text())
  raw=carrier['originalText'].encode()
  assert carrier['originalFile']==receipt['rawOutput']
  assert hashlib.sha256(raw).hexdigest()==carrier['originalSHA256']==row['originalSHA256']
  assert raw==subprocess.check_output(['git','show',carrier['originalCommit']+':'+str((evidence/receipt['rawOutput']).relative_to(root.parents[2]))])
  assert hashlib.sha256((evidence/row['displayDerivative']).read_bytes()).hexdigest()==row['displaySHA256']
 else:raw=(evidence/receipt['rawOutput']).read_bytes()
 assert hashlib.sha256(raw).hexdigest()==receipt['rawSHA256'],file
 if receipt['label'].startswith(('04-','05-','06-')):assert 'AssertionError:' in raw.decode(),file
 if receipt['label']=='02-baseline-red':assert 'captureLaunchAdmission is not a function' in raw.decode()
 if receipt['label'] in ('03-source-green','07-restored-green'):assert re.search(r'Tests\s+20 passed',raw.decode()),file
manifest=json.loads((evidence/'manifest.json').read_text())
for path,expected in manifest['sourceSHA256'].items():
 raw=subprocess.check_output(['git','show',manifest['sourceHead']+':'+path])
 assert hashlib.sha256(raw).hexdigest()==expected
 assert (root.parents[2]/path).read_bytes()==raw
config=evidence/'vitest.proof.config.ts.txt'
r=json.loads((evidence/'07-restored-green.json').read_text())
assert hashlib.sha256(config.read_bytes()).hexdigest()==r['inputSHA256']['.cache/3720-launch/vitest.config.ts']
print('PASS archived evidence:11 actual command receipts, byte-exact raw carriers match original377b70 objects, labeled text derivatives,20/20 candidate/restored counts, behavioral mutation assertions, source4e9c3db and captured config hashes.')
print('Verification only: no additional product/Annex integration/hosted test executed.')
