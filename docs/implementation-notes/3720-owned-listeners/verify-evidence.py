"""Verify actual archive/head/default-body bindings without tests/install/shared writes."""
from pathlib import Path
import hashlib,json,subprocess

root=Path(__file__).resolve().parent
repo=root.parents[2]
manifest=root/'SHA256SUMS.txt';sealed=set()
for line in manifest.read_text().splitlines():
    digest,name=line.split('  ',1)
    assert name not in sealed and '..' not in Path(name).parts
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest,name
    sealed.add(name)
assert sealed=={str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p!=manifest}
binding=json.loads((root/'source-binding.json').read_text())
for name,digest in binding['candidateSHA256'].items():
    assert hashlib.sha256((repo/name).read_bytes()).hexdigest()==digest,name
artifact=(root/'approved-d64-functions.txt').read_text()
invariant=json.loads((root/'source-invariants.json').read_text())
assert hashlib.sha256(artifact.encode()).hexdigest()==invariant['approvedArtifactSHA256']
assert artifact.startswith('// REVIEW ONLY:')
base=subprocess.check_output(['git','show',binding['base']+':src/main/services/annex-server.ts'],cwd=repo,text=True)
anchor='function startServer(strict = false): Promise<void> {'
assert base.count(anchor)==1
assert (repo/'src/main/services/annex-server.ts').read_text()==base.replace(anchor,artifact.split('\n',1)[1]+'\n'+anchor)
records={p.stem:json.loads(p.read_text()) for p in (root/'evidence').glob('*.json')}
assert len(records)==19
runner_hash=hashlib.sha256((root/'run-proof.py').read_bytes()).hexdigest()
for label,record in records.items():
    assert record['label']==label and record['inputSHA256']==record['inputSHA256After'],label
    assert record['runnerSHA256']==runner_hash,label
    if label in ['candidate-green','full-server-suite']:
        assert record['expectedExit']==0 and record['actualExit']==1 and 'AssertionError' in record['stderr'],label
        assert '1 failed' in record['stdout']
    else:
        assert record['actualExit']==record['expectedExit'],label
for label in ['final-targeted','final-full-server-suite','restored-targeted','final-types','final-lint','final-diff']:
    record=records[label]
    assert record['headAtExecution']==binding['candidateHead'] and record['actualExit']==0 and not record['sourceDiff'],label
    for name,digest in binding['candidateSHA256'].items():
        assert record['inputSHA256'][name]==digest,(label,name)
assert '658 passed' in records['final-full-server-suite']['stdout']
assert '14 passed | 644 skipped' in records['final-targeted']['stdout']
assert '14 passed | 644 skipped' in records['restored-targeted']['stdout']
assert '10 failed | 1 passed | 644 skipped' in records['missing-api-red']['stdout']
assert 'is not a function' in records['missing-api-red']['stderr']
summary=json.loads((root/'mutant-summary.json').read_text())
assert summary['head']==binding['candidateHead'] and len(summary['mutants'])==8
assert summary['originalSourceSHA256']==summary['restoredSourceSHA256']==binding['candidateSHA256']['src/main/services/annex-server.ts']
assert summary['driverSHA256']==hashlib.sha256((root/'run-mutants.py').read_bytes()).hexdigest()
for item in summary['mutants']:
    record=records['mutant-'+item['label']]
    assert record['actualExit']==1 and 'AssertionError' in record['stderr'] and record['sourceDiff']
    assert record['headAtExecution']==binding['candidateHead']
    assert record['inputSHA256']['src/main/services/annex-server.ts']==item['mutatedSourceSHA256']
print(f'{len(sealed)} seals/{len(records)} actual receipts verified; only approved d64 additions on {binding["candidateHead"]}')
