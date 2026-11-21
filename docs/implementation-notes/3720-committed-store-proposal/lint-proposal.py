#!/usr/bin/env python3
"""Lint unapplied text using the exact intended filenames and existing config."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
DOC = Path(__file__).resolve().parent
target = ROOT / '.cache/3720-committed-store-review/records/frozen-a2c6b9ab5-lint.json'
assert not target.exists(), 'Never overwrite original outcomes'
files = [
    ('annex-committed-store.review.ts.txt', 'src/main/services/annex-committed-store.ts'),
    ('recovery-tickets.review.ts.txt', 'src/main/services/annex-settings-recovery.ts'),
    ('settings-store.proposed.ts.txt', 'src/main/services/settings-store.ts'),
]
results = []
for name, intended in files:
    source = (DOC / name).read_text()
    args = [str(ROOT / 'node_modules/.bin/eslint'), '--quiet', '--stdin', '--stdin-filename', intended]
    start = time.time()
    run = subprocess.run(args, input=source, cwd=ROOT, capture_output=True, text=True,
                         env={**os.environ, 'NODE_DISABLE_COMPILE_CACHE': '1'})
    results.append({'source': name, 'sourceSHA256': hashlib.sha256(source.encode()).hexdigest(),
                    'argv': args, 'startedUnix': start, 'finishedUnix': time.time(),
                    'exitCode': run.returncode, 'stdout': run.stdout, 'stderr': run.stderr})
target.write_text(json.dumps({'kind': 'unapplied-proposal-stdin-errors-only-lint',
    'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'results': results}, indent=2) + '\n')
print(json.dumps({'record': str(target.relative_to(ROOT)), 'results': results}))
raise SystemExit(max(r['exitCode'] for r in results))
