"""Documentation/context checks only. Does not import/execute proposed product code."""
from pathlib import Path
import subprocess,hashlib,json,tempfile,re
root=Path(__file__).resolve().parent
binding=json.loads((root/'source-binding.json').read_text())
with tempfile.TemporaryDirectory(prefix='3720-r2-context-') as tmp:
 for name,expected in binding['sha256'].items():
  raw=subprocess.check_output(['git','show',binding['sourceCommit']+':'+name])
  assert hashlib.sha256(raw).hexdigest()==expected,name
  p=Path(tmp)/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
 subprocess.run(['git','apply','--check','--unidiff-zero',str(root/binding['patch'])],cwd=tmp,check=True)
fixture=json.loads((root/'fixtures.json').read_text())
ids=[row['id'] for row in fixture['cases']];assert len(ids)==len(set(ids))
assert fixture['optionalTransitionVersions']==list(range(6))
assert len(set(fixture['epochExamples']))==2
for epoch in fixture['epochExamples']:assert re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',epoch)
retained=json.loads((root/'retained-r1-readback.json').read_text())
raw=subprocess.check_output(['git','show',retained['retainedCommit']+':'+retained['path']])
assert hashlib.sha256(raw).hexdigest()==retained['sha256']
prefix='docs/implementation-notes/3720-negotiated-member-names'
for path in subprocess.check_output(['git','ls-tree','-r','--name-only',retained['retainedCommit'],'--',prefix],text=True).splitlines():
 assert Path(path).read_bytes()==subprocess.check_output(['git','show',retained['retainedCommit']+':'+path]),path
print(f'PASS docs only: {len(binding["sha256"])} source hashes, git apply --check on disposable copies, {len(ids)} unique expected-case inventory, epoch/transition arithmetic, retained r1/frozen docs byte equality.')
print('No patch applied; no DTO parser, store, renderer, teardown, race, type/lint, old/new endpoint or product test executed. Missing helpers remain unimplemented.')
