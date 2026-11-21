from pathlib import Path
import hashlib,json

root=Path(__file__).resolve().parent;repo=root.parents[2]
seen=set()
for line in (root/'SHA256SUMS.txt').read_text().splitlines():
    digest,name=line.split('  ',1)
    assert name not in seen and '..' not in Path(name).parts
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest,name
    seen.add(name)
assert seen=={p.name for p in root.iterdir() if p.is_file() and p.name!='SHA256SUMS.txt'}
r=json.loads((root/'callers.json').read_text())
assert len(r['createSettingsStoreCallSites'])==46 and len(r['replaceFileCallSites'])==6 and len(r['directReplaceImports'])==5
assert len(r['annexWriteReferences'])==5 and all(v['directCall'] for v in r['annexWriteReferences'])
assert hashlib.sha256((root/'collect-callers.cjs').read_bytes()).hexdigest()==r['collectorSHA256']
for name,digest in r['sourceSHA256'].items():
    assert hashlib.sha256((repo/name).read_bytes()).hexdigest()==digest,name
failure=json.loads((root/'local-save-producers.failure.json').read_text())
assert failure['actualExit']==2 and 'No such file or directory' in failure['stderr']
old=json.loads((root/'callers.parentless.json').read_text())
assert old['annexWriteReferences'] and not any(v['directCall'] for v in old['annexWriteReferences'])
assert hashlib.sha256((root/'collect-callers.parentless.cjs').read_bytes()).hexdigest()==old['collectorSHA256']
for name in ['annex-main-writers.txt.json','local-save-producers.txt.json']:
    assert json.loads((root/name).read_text())['actualExit']==0
print(f'{len(seen)} source-audit seals verified; 46 store sites/5 direct importers/5 Annex writer sites. No product proof.')
