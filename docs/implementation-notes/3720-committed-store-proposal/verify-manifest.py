#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'manifest.json').read_text())
for name, expected in manifest['files'].items():
    file = root / name
    assert file.is_file(), name
    assert hashlib.sha256(file.read_bytes()).hexdigest() == expected, name
assert set(manifest['files']) == {
    str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.name != 'manifest.json'
}
print(json.dumps({'sealedFiles': len(manifest['files']), 'source': manifest['source'], 'verified': True}))
