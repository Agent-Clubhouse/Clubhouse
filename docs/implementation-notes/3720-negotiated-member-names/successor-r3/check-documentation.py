"""Documentation/source-context checks only; never imports proposed product/parser code."""
from pathlib import Path
import subprocess,tempfile,hashlib,json
root=Path(__file__).resolve().parent
binding=json.loads((root/'source-binding.json').read_text())
with tempfile.TemporaryDirectory(prefix='3720-r3-context-') as tmp:
 for name,expected in binding['sha256'].items():
  raw=subprocess.check_output(['git','show',binding['sourceCommit']+':'+name])
  assert hashlib.sha256(raw).hexdigest()==expected,name
  assert raw==subprocess.check_output(['git','show',binding['sourceByteEqualTo']+':'+name]),name
  p=Path(tmp)/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
 subprocess.run(['git','apply','--check','--unidiff-zero',str(root/binding['patch'])],cwd=tmp,check=True)
fixture=json.loads((root/'fixtures.json').read_text())
ids=[r['id'] for r in fixture['cases']]
assert len(ids)==len(set(ids))==fixture['caseCount']
assert fixture['recoveryBounds']['sequentialFailuresBeforeSuccessControl']>fixture['recoveryBounds']['recentCompletedGlobal']==32
assert fixture['recoveryBounds']['inFlight']==1
assert 'as unknown as' not in (root/'strict-parser-body.review.txt').read_text()
retained='15383280a1bdd7151b07a66e4177eef38d10b40c'
prefix='docs/implementation-notes/3720-negotiated-member-names'
for path in subprocess.check_output(['git','ls-tree','-r','--name-only',retained,'--',prefix],text=True).splitlines():
 assert Path(path).read_bytes()==subprocess.check_output(['git','show',retained+':'+path]),path
review=json.loads((root/'review-and-retained-binding.json').read_text())
assert hashlib.sha256(subprocess.check_output(['git','show',review['reviewCommit']+':'+review['reviewPath']])).hexdigest()==review['reviewSHA256']
assert hashlib.sha256((root.parent/'successor-r2/launch-gate.review.patch').read_bytes()).hexdigest()==binding['unchangedLaunchPatchSha256']
print(f'PASS docs only:8 current-main source hashes/equality, corrected scaffold git apply--check on disposable copies, {len(ids)} unique discriminator inventory,40>32 arithmetic, frozen r2/earlier bytes and review/launch hashes.')
print('No parser/schema/clone/store/renderer/recovery/emergency/teardown/type/lint or product test ran. Scaffold helpers remain unimplemented.')
