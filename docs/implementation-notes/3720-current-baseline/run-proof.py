#!/usr/bin/env python3
"""Record one bounded current-source diagnostic; do not overwrite receipts."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / '.cache/3720-current-baseline'
OUT.mkdir(parents=True, exist_ok=True)
label, *argv = sys.argv[1:]
target = OUT / (label + '.json')
assert argv and not target.exists()
inputs = ['src/main/services/annex-network-membership.ts',
          'src/main/services/annex-network-membership.test.ts',
          'src/main/services/annex-network-channel.ts',
          'src/main/services/settings-store.ts', 'src/shared/annex-network-protocol.ts',
          'package-lock.json', 'vitest.config.ts', 'test/standard-runtime-boundary.ts']
def hashes():
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in inputs}
def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True)
before = hashes()
versions = json.loads((ROOT / 'package-lock.json').read_text())['packages']
checked = 0
for name, value in versions.items():
    if not name or value.get('optional') or value.get('link'):
        continue
    assert json.loads((ROOT / name / 'package.json').read_text())['version'] == value['version'], name
    checked += 1
admission = {'cpus': os.cpu_count(), 'load': os.getloadavg(), 'matchedVersions': checked,
             'cache': str((ROOT / 'node_modules').resolve())}
assert admission['load'][0] < admission['cpus'] / 2, admission
record = {'headBefore': git('rev-parse', 'HEAD').strip(), 'inputsBefore': before,
          'trackedDiffBefore': git('diff', 'HEAD', '--', *inputs), 'argv': argv,
          'admission': admission, 'startedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'runnerSHA256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
result = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True,
                        env={**os.environ, 'NODE_DISABLE_COMPILE_CACHE': '1', 'FORCE_COLOR': '0'})
record.update({'headAfter': git('rev-parse', 'HEAD').strip(), 'inputsAfter': hashes(),
               'trackedDiffAfter': git('diff', 'HEAD', '--', *inputs),
               'finishedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
target.write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'record': str(target.relative_to(ROOT)), 'exit': result.returncode}))
print(result.stdout)
print(result.stderr)
assert record['headBefore'] == record['headAfter'] and record['inputsBefore'] == record['inputsAfter']
assert result.returncode == 1, 'Expected a current-baseline diagnostic failure, not green feature acceptance'
