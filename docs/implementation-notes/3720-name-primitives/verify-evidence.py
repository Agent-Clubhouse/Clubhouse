"""Read-only verification of original proof and exact source, not a test rerun."""
from pathlib import Path
import hashlib,json

root=Path(__file__).resolve().parent
repo=root.parents[2]
manifest=root/'SHA256SUMS.txt'
sealed=set()
for line in manifest.read_text().splitlines():
    digest,name=line.split('  ',1)
    assert name not in sealed and '..' not in Path(name).parts
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest,name
    sealed.add(name)
assert sealed=={str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p!=manifest}
binding=json.loads((root/'source-binding.json').read_text())
for name,digest in {**binding['candidateSHA256'],**binding['unchangedContextSHA256']}.items():
    assert hashlib.sha256((repo/name).read_bytes()).hexdigest()==digest,name
records={p.stem:json.loads(p.read_text()) for p in (root/'evidence').glob('*.json')}
assert len(records)==24
runner_hash=hashlib.sha256((root/'run-proof.py').read_bytes()).hexdigest()
for label,record in records.items():
    assert record['label']==label and record['actualExit']==record['expectedExit'],label
    assert record['inputSHA256']==record['inputSHA256After'],label
    assert record['runnerSHA256']==runner_hash,label
for label in ['final-green','restored-green','final-types','final-lint','final-diff','independent-vectors']:
    record=records[label]
    assert record['headAtExecution']==binding['candidateHead'] and record['actualExit']==0
    assert not record['sourceDiff'],label
    for name,digest in binding['candidateSHA256'].items():
        assert record['inputSHA256'][name]==digest,(label,name)
assert '126 passed' in records['final-green']['stdout'] and '126 passed' in records['restored-green']['stdout']
assert 'unexpected end of hex escape' in records['missing-api-red']['stderr']
assert 'no tests' in records['missing-api-red']['stdout']
assert 'Cannot find module' in records['missing-api-red-valid-fixture']['stderr']
assert 'no tests' in records['missing-api-red-valid-fixture']['stdout']
assert '11 canonical byte/SHA256 vectors' in records['independent-vectors']['stdout']
summary=json.loads((root/'mutant-summary.json').read_text())
assert summary['head']==binding['candidateHead'] and len(summary['mutants'])==13
assert summary['originalSourceSHA256']==summary['restoredSourceSHA256']==binding['candidateSHA256']['src/shared/annex-member-names.ts']
assert summary['runnerSHA256']==hashlib.sha256((root/'run-mutants.py').read_bytes()).hexdigest()
for item in summary['mutants']:
    record=records['mutant-'+item['label']]
    assert record['actualExit']==1 and 'AssertionError' in record['stderr']
    assert record['sourceDiff'] and record['headAtExecution']==binding['candidateHead']
    assert record['inputSHA256']['src/shared/annex-member-names.ts']==item['mutatedSourceSHA256']
print(f'{len(sealed)} seals and {len(records)} actual receipts verified, source {binding["candidateHead"]}')
