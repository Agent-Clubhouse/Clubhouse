"""Documentation and patch-context check only. No product files modified/executed."""
from pathlib import Path
import subprocess, tempfile, json, hashlib
root = Path(__file__).resolve().parent
binding = json.loads((root / 'source-binding.json').read_text())
for name, expected in binding['sha256'].items():
    raw = subprocess.check_output(['git', 'show', binding['sourceCommit'] + ':' + name])
    assert hashlib.sha256(raw).hexdigest() == expected, name
    old = subprocess.check_output(['git', 'show', 'be29c82a5eba1003d06a992209f6536506062b64:' + name])
    assert raw == old, 'source equality: ' + name
with tempfile.TemporaryDirectory(prefix='3720-review-context-') as tmp:
    for name in binding['sha256']:
        p = Path(tmp) / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(subprocess.check_output(['git', 'show', binding['sourceCommit'] + ':' + name]))
    subprocess.run(['git', 'apply', '--check', '--unidiff-zero', str(root / binding['patch'])], cwd=tmp, check=True)
print('PASS documentation patch-context check only: 5 exact50cb source hashes, be29 equality, git apply --check --unidiff-zero against disposable copies.')
print('Patch NOT applied. No product type, lint, test, runtime or race execution. Proposed APIs are not implemented.')
