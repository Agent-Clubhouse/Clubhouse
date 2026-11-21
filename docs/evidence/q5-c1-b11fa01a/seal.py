"""Seal targeted C1 notice-eligibility checks inside desktop-test-gate."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

FILES = ['.github/workflows/validate.yml', 'docs/design/q5-journal-integration-contract.md', 'docs/design/q5-journal-integration-source.json', 'docs/design/q5-root-state-batch.md', 'docs/design/q5-root-state-imported-source-bridge.json', 'eslint.config.mjs', 'package-lock.json', 'package.json', 'src/main/services/group-project-bulletin.ts', 'src/main/services/group-project-delivery.test.ts', 'src/main/services/group-project-delivery.ts', 'src/main/services/group-project-host.ts', 'src/main/services/group-project-notice-ledger/durability.test.ts', 'src/main/services/group-project-notice-ledger/durability.ts', 'src/main/services/group-project-notice-ledger/intervals.test.ts', 'src/main/services/group-project-notice-ledger/intervals.ts', 'src/main/services/group-project-notice-ledger/pages.test.ts', 'src/main/services/group-project-notice-ledger/pages.ts', 'src/main/services/group-project-notice-ledger/sparse-reader.test.ts', 'src/main/services/group-project-notice-ledger/sparse-reader.ts', 'src/main/services/group-project-notice-ledger/sparse-state.test.ts', 'src/main/services/group-project-notice-ledger/sparse-state.ts', 'src/main/services/group-project-notice-ledger/state.test.ts', 'src/main/services/group-project-notice-ledger/state.ts', 'src/shared/group-project-network.ts', 'src/shared/group-project-types.ts', 'test/global-setup.ts', 'test/research/q5-index-process.cjs', 'test/standard-runtime-boundary.ts', 'tsconfig.json', 'vitest.config.ts']


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def state():
    return {
        'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
        'status': git('status', '--porcelain', '--untracked-files=all'),
        'sealerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'sources': {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in sorted(FILES)},
    }


destination = Path(sys.argv[1])
argv = sys.argv[2:]
if argv and argv[0] == '--':
    argv = argv[1:]
if not argv:
    raise SystemExit('Missing admitted command')
destination.mkdir(parents=True, exist_ok=False)
before = state()
if before['status']:
    raise SystemExit('Refusing dirty C1 source')
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
finished = datetime.datetime.now(datetime.timezone.utc).isoformat()
after = state()
(destination / 'raw.txt').write_bytes(result.stdout)
receipt = {
    'scope': 'targeted C1 existing delivery-policy controls with mocked host/board/runtime; no scan adapter or producer implementation',
    'startedAt': started, 'finishedAt': finished, 'cwd': str(Path.cwd()),
    'argv': argv, 'exitCode': result.returncode, 'before': before, 'after': after,
    'sealEqual': before == after, 'rawSha256': hashlib.sha256(result.stdout).hexdigest(),
}
(destination / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
sys.stdout.buffer.write(result.stdout)
print(json.dumps({'receipt': str(destination / 'receipt.json'), 'exitCode': result.returncode, 'sealEqual': before == after}))
raise SystemExit(result.returncode if result.returncode else (0 if before == after else 3))
