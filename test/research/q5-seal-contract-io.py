"""Research receipt wrapper; invoke inside desktop-test-gate, not product code."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def source_state():
    sources = [
        'docs/design/q5-durable-notice-ledger.md',
        'docs/design/q5-issue-publication-draft.json',
        'test/research/q5-storage-envelope.mjs',
        'test/research/q5-seal-contract-io.py',
    ]
    return {
        'head': command('git', 'rev-parse', 'HEAD'),
        'tree': command('git', 'rev-parse', 'HEAD^{tree}'),
        'status': command('git', 'status', '--porcelain'),
        'sha256': {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in sources},
    }


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=False)
before = source_state()
if before['status']:
    raise SystemExit('Refusing dirty research source')
argv = ['node', 'test/research/q5-storage-envelope.mjs']
started = timestamp()
result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
finished = timestamp()
raw = destination / 'io.raw.txt'
raw.write_bytes(result.stdout)
after = source_state()
receipt = {
    'scope': 'isolated contract research IO only; not product proof',
    'startedAt': started,
    'finishedAt': finished,
    'cwd': str(Path.cwd()),
    'argv': argv,
    'exitCode': result.returncode,
    'before': before,
    'after': after,
    'sealEqual': before == after,
    'rawSha256': hashlib.sha256(result.stdout).hexdigest(),
}
(destination / 'io.receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
sys.stdout.buffer.write(result.stdout)
print(json.dumps({'receipt': str(destination / 'io.receipt.json'), 'exitCode': result.returncode, 'sealEqual': before == after}))
raise SystemExit(result.returncode if result.returncode else (0 if before == after else 3))
