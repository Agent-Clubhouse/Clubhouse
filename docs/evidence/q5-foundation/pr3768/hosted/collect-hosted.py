"""Extract exact Q5 JUnit/log slices; no native execution or GitHub write."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
OUT = HERE / 'hosted'
OUT.mkdir(exist_ok=False)
sha = lambda b: hashlib.sha256(b).hexdigest()
HEAD = '0e6c898ada85efefb80bc3aec61e07d3d15d2b19'
MERGE = 'a2b621bbd6790059d22abaae2ef519b747bb202e'
NATIVE = 'native Windows reuse sync succeeds without platform or descriptor overrides'
EXPECTED_SKIPS = [
    'preserves native POSIX read-only reuse and actual sync',
    'refuses an actual regular-file to FIFO swap without a blocking open',
]
metadata = json.loads((HERE / 'windows-artifacts.json').read_bytes())
run = json.loads((HERE / 'final-run.json').read_bytes())
job = json.loads((HERE / 'windows-job2.json').read_bytes())
assert run['headSha'] == HEAD and run['conclusion'] == 'success'
assert job['id'] == 136913610220 and job['run_id'] == 44926471482 and job['conclusion'] == 'success'
artifacts = []
cases = []
suites = []
for shard, artifact_id in [(1, 14716785413), (2, 14716349143)]:
    row = next(a for a in metadata if a['id'] == artifact_id)
    assert row['name'] == f'test-results-windows-latest-{shard}' and row['workflow_run']['head_sha'] == HEAD
    archive = HERE / f'windows-shard{shard}-artifact{artifact_id}.zip'
    data = (HERE / f'windows-shard{shard}-test-results.xml').read_bytes()
    assert sha(archive.read_bytes()) == row['digest'].removeprefix('sha256:')
    report = ET.fromstring(data)
    record = dict(row, zipSha256=sha(archive.read_bytes()), xmlSha256=sha(data), xmlBytes=len(data),
                  reportAttributes=report.attrib, q5Suites=[])
    for match in re.finditer(rb'<testsuite(?=\s)[\s\S]*?</testsuite>', data):
        suite = ET.fromstring(match.group())
        if 'group-project-notice-ledger/' not in suite.attrib.get('name', ''):
            continue
        raw_name = f'windows-shard{shard}-{Path(suite.attrib["name"]).name}.testsuite.xml'
        (OUT / raw_name).write_bytes(match.group())
        items = []
        for case in suite.iter('testcase'):
            status = 'failed' if case.find('failure') is not None or case.find('error') is not None else 'skipped' if case.find('skipped') is not None else 'passed'
            item = dict(case.attrib, status=status, suite=suite.attrib['name'], shard=shard,
                        skippedXml=ET.tostring(case.find('skipped'), encoding='unicode') if status == 'skipped' else None)
            items.append(item)
            cases.append(item)
        assert len(items) == int(suite.attrib['tests'])
        assert sum(c['status'] == 'failed' for c in items) == 0
        assert sum(c['status'] == 'skipped' for c in items) == int(suite.attrib.get('skipped', 0))
        entry = dict(attributes=suite.attrib, rawFile=raw_name, rawSha256=sha(match.group()),
                     byteStart=match.start(), byteEnd=match.end(), cases=items)
        suites.append(entry)
        record['q5Suites'].append(dict(name=suite.attrib['name'], rawFile=raw_name, rawSha256=entry['rawSha256']))
    artifacts.append(record)
assert len(suites) == 2 and all(s['cases'][0]['shard'] == 2 for s in suites)
native = [c for c in cases if c['name'].endswith(' > ' + NATIVE)]
assert len(native) == 1 and native[0]['status'] == 'passed'
skips = [c for c in cases if c['status'] == 'skipped']
assert sorted(c['name'].split(' > ', 1)[1] for c in skips) == sorted(EXPECTED_SKIPS)
assert sum(c['status'] == 'passed' for c in cases) == 48

log = (HERE / 'windows-shard2-job136913610220.log').read_bytes()
lines = log.splitlines(keepends=True)
offsets = [0]
for line in lines:
    offsets.append(offsets[-1] + len(line))
checkout = []
for index, line in enumerate(lines[:-1]):
    if b'log -1 --format=%H' in line:
        value = re.search(rb'\b([0-9a-f]{40})\s*$', lines[index + 1])
        if value:
            checkout.append((index, value.group(1).decode()))
assert len(checkout) == 1 and checkout[0][1] == MERGE
excerpts = []
def save_excerpt(name, start, end):
    body = log[start:end]
    (OUT / name).write_bytes(body)
    excerpts.append(dict(file=name, sha256=sha(body), byteStart=start, byteEnd=end))
def group(name, pattern):
    match = re.search(pattern, log)
    assert match, name
    start = log.rfind(b'\n', 0, match.start()) + 1
    closing = log.index(b'##[endgroup]', match.end())
    end = log.index(b'\n', closing) + 1
    save_excerpt(name, start, end)
group('job-operating-system.log', rb'##\[group\]Operating System\r?\n')
group('job-runner-image.log', rb'##\[group\]Runner Image\r?\n')
group('job-node-environment.log', rb'##\[group\]Environment details\r?\n')
start = log.rfind(b'\n', 0, log.index(b'##[group]Checking out the ref')) + 1
save_excerpt('job-actual-checkout.log', start, offsets[checkout[0][0] + 2])
assert b'Microsoft Windows Server 2025' in log and b'node: v22.23.4' in log

bridge = json.loads((HERE / 'f19-composition-merge-bridge.json').read_bytes())
for row in bridge['fiveFiles']:
    actual = subprocess.check_output(['git', 'show', MERGE + ':' + row['path']])
    assert sha(actual) == row['sourceSha256'] == row['mergeSha256']
summary = dict(
    scope='Observed native regular-file index tests only; independent hosted assessment pending',
    run=run, windowsJob=job, actualCheckout=MERGE, fiveFileGitBlobBridge=bridge['fiveFiles'],
    G2=dict(nativeCaseCount=1, status='passed', nativeCase=native[0]),
    G4=dict(passedCases=48, failedCases=0, skippedCases=skips, unexpectedSkips=[],
            symlinkCreationSkips=[], notes='All process-exit, symlink, prefix-rename and cleanup cases passed; only explicit POSIX/FIFO platform cases skipped.'),
    artifacts=artifacts, suites=suites,
    rawJobLog=dict(sha256=sha(log), bytes=len(log), excerpts=excerpts),
    collectorSha256=sha(Path(__file__).read_bytes()),
    limits=[
        'Canonical Git blob hashes plus actual checkout log, not an atomic hosted working-tree seal.',
        'Windows Server2025 image windows-2025-vs2026, Node22.23.4; filesystem type not recorded.',
        'Directory durability mode is not emitted by the native testcase; no stronger sync/power-loss claim.',
        'FAT/network/ino=0 and native read-only attributes/deny-write sharing are unproved; access failures must refuse.',
        'Synthetic descriptor failure controls and directory policy mocks are not OS-injected disk failures.',
        'No catalog/activation/R1/migration/runtime/UI/whole-heap acceptance or merge/release authority.',
    ],
)
(OUT / 'hosted-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
(OUT / 'collect-hosted.py').write_bytes(Path(__file__).read_bytes())
print(json.dumps(dict(native=native[0]['status'], q5Passed=48, q5Skipped=len(skips),
                     unexpectedSkips=0, actualCheckout=MERGE, fiveHashesEqual=True,
                     rawQ5Suites=[s['rawFile'] for s in suites])))
