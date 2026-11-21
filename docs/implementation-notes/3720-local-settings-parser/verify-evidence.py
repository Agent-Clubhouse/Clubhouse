"""Verify the retained archive; no installs, tests or shared writes."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
repo = root.parents[2]
manifest = root / 'SHA256SUMS.txt'
sealed = set()
for line in manifest.read_text().splitlines():
    expected, name = line.split('  ', 1)
    assert name not in sealed and '..' not in Path(name).parts
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
    sealed.add(name)
assert sealed == {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p != manifest}
binding = json.loads((root / 'source-binding.json').read_text())
for name, expected in binding['candidateSHA256'].items():
    assert hashlib.sha256((repo / name).read_bytes()).hexdigest() == expected, name
runner_hash = hashlib.sha256((root / 'run-proof.py').read_bytes()).hexdigest()
records = {p.stem: json.loads(p.read_text()) for p in (root / 'evidence').glob('*.json')}
for label, record in records.items():
    assert record['label'] == label
    assert record['inputSHA256'] == record['inputSHA256After'], label
    assert record['runnerSHA256'] == runner_hash, label
    if label == 'candidate-types':
        assert record['actualExit'] == 2 and 'TS2550' in record['stdout']
    else:
        assert record['actualExit'] == record['expectedExit'], label
for label in ['sealed-green', 'restored-green', 'sealed-types', 'sealed-lint', 'sealed-diff']:
    record = records[label]
    assert record['headAtExecution'] == binding['candidateHead'] and record['actualExit'] == 0
    assert not record['sourceDiff'], label
    for name, expected in binding['candidateSHA256'].items():
        assert record['inputSHA256'][name] == expected, (label, name)
assert '112 passed' in records['sealed-green']['stdout']
assert '112 passed' in records['restored-green']['stdout']
assert 'no tests' in records['missing-api-red']['stdout']
assert 'Cannot find module' in records['missing-api-red']['stderr']
assert '1 failed | 111 passed' in records['reflection-error-red']['stdout']
for summary_file, driver in [('mutant-summary.json', 'run-mutants-initial.py'), ('sealed-mutant-summary.json', 'run-mutants.py')]:
    summary = json.loads((root / summary_file).read_text())
    assert summary['runnerSHA256'] == hashlib.sha256((root / driver).read_bytes()).hexdigest()
    assert summary['originalSourceSHA256'] == summary['restoredSourceSHA256']
    prefix = 'sealed-mutant-' if summary_file.startswith('sealed') else 'mutant-'
    for item in summary['mutants']:
        record = records[prefix + item['label']]
        assert record['actualExit'] == 1 and 'AssertionError' in record['stderr']
        assert record['sourceDiff'] and record['inputSHA256']['src/shared/annex-settings-ipc.ts'] == item['mutatedSourceSHA256']
    if prefix == 'sealed-mutant-':
        assert len(summary['mutants']) == 8 and summary['head'] == binding['candidateHead']
        assert summary['originalSourceSHA256'] == binding['candidateSHA256']['src/shared/annex-settings-ipc.ts']
print(f'{len(sealed)} seals and {len(records)} actual command receipts verified; final source bound to {binding["candidateHead"]}')
