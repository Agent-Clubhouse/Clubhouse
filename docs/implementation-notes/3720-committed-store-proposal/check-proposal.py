#!/usr/bin/env python3
"""Materialize an isolated symlink mirror; never apply review files to source."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
DOC = Path(__file__).resolve().parent
TASK = ROOT / '.cache/3720-committed-store-review'
PATCHED = {
    'src/main/services/settings-store.ts': 'settings-store.proposed.ts.txt',
    'src/main/services/annex-committed-store.ts': 'annex-committed-store.review.ts.txt',
    'src/main/services/annex-settings-recovery.ts': 'recovery-tickets.review.ts.txt',
}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

label = sys.argv[1]
records = TASK / 'records'
records.mkdir(parents=True, exist_ok=True)
record = records / (label + '.json')
if record.exists():
    raise SystemExit('Refusing to overwrite original record')
if not (TASK / 'node_modules').exists():
    (TASK / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
for src in (ROOT / 'src').rglob('*'):
    rel = src.relative_to(ROOT)
    dst = TASK / rel
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
    elif str(rel) not in PATCHED and not dst.exists():
        dst.symlink_to(src)
for target, source in PATCHED.items():
    dest = TASK / target
    if dest.is_symlink():
        dest.unlink()
    dest.write_bytes((DOC / source).read_bytes())
config = {
    'extends': '../../tsconfig.json',
    'compilerOptions': {'noEmit': True, 'incremental': False},
    'include': ['src/**/*'],
    'exclude': ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.qa.ts'],
}
(TASK / 'tsconfig.json').write_text(json.dumps(config, indent=2) + '\n')
inputs = {name: sha(DOC / name) for name in PATCHED.values()}
inputs['check-proposal.py'] = sha(Path(__file__))
args = [str(ROOT / 'node_modules/.bin/tsc'), '--project', str(TASK / 'tsconfig.json'), '--noEmit']
start = time.time()
run = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                     env={**os.environ, 'NODE_DISABLE_COMPILE_CACHE': '1'})
payload = {
    'kind': 'unapplied-proposal-typecheck-only',
    'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'trackedDiff': subprocess.check_output(['git', 'diff', 'HEAD', '--', 'src'], cwd=ROOT, text=True),
    'proposalTracked': subprocess.check_output(['git', 'ls-files', str(DOC.relative_to(ROOT))], cwd=ROOT, text=True),
    'inputsBefore': inputs,
    'inputsAfter': {name: sha(DOC / name) for name in inputs},
    'argv': args, 'startedUnix': start, 'finishedUnix': time.time(),
    'loadAfter': os.getloadavg(), 'exitCode': run.returncode,
    'stdout': run.stdout, 'stderr': run.stderr,
}
record.write_text(json.dumps(payload, indent=2) + '\n')
print(json.dumps({'record': str(record.relative_to(ROOT)), 'exit': run.returncode,
                  'seconds': payload['finishedUnix'] - start, 'stdout': run.stdout, 'stderr': run.stderr}))
raise SystemExit(run.returncode)
