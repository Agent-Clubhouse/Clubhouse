"""Capture actual command output and input binding without installs/cache writes."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import subprocess
import sys

repo = Path(__file__).resolve().parents[3]
label, expected, *argv = sys.argv[1:]
if not argv:
    raise SystemExit('usage: run-proof.py LABEL EXPECTED_EXIT COMMAND ...')
inputs = [
    'src/main/services/annex-server.ts', 'src/main/services/annex-server.test.ts',
    'src/main/services/settings-store.ts', 'src/main/services/annex-settings.ts',
    'src/main/services/annex-network-profile.ts',
    'src/shared/types.ts', 'package-lock.json', 'vitest.config.ts',
    '.cache/3720-owned-listeners/vitest.config.ts',
]
def hashes():
    return {p: hashlib.sha256((repo / p).read_bytes()).hexdigest()
            if (repo / p).exists() else None for p in inputs}
before = hashes()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
diff = subprocess.check_output(['git', 'diff', '--', *inputs], cwd=repo, text=True)
env = os.environ.copy()
env.update(NODE_DISABLE_COMPILE_CACHE='1', FORCE_COLOR='0')
result = subprocess.run(argv, cwd=repo, env=env, text=True, capture_output=True)
record = dict(label=label, headAtExecution=head, argv=argv, expectedExit=int(expected),
              actualExit=result.returncode, startedAtUTC=started,
              endedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              inputSHA256=before, inputSHA256After=hashes(), sourceDiff=diff,
              stdout=result.stdout, stderr=result.stderr,
              environmentOverrides=dict(NODE_DISABLE_COMPILE_CACHE='1', FORCE_COLOR='0'),
              runnerSHA256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
target = repo / '.cache/3720-owned-listeners/records'
target.mkdir(parents=True, exist_ok=True)
(target / (label + '.json')).write_text(json.dumps(record, indent=2) + '\n')
print(f'{label}: actual exit {result.returncode}, expected {expected}')
print(result.stdout[-6000:])
print(result.stderr[-4000:])
if result.returncode != int(expected) or record['inputSHA256After'] != before:
    raise SystemExit(1)
