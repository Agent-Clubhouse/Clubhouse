#!/usr/bin/env python3
"""Run through desktop-test-gate.sh (4 GB). Each child is targeted, one worker.
Restores every production file even if interrupted. Logs every original FAIL.
This script intentionally expects failing tests for main and guard mutants.
"""
from pathlib import Path
import argparse
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--logs', default='/tmp/annex-p6-binary-controls')
parser.add_argument('--only')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
logs = Path(args.logs); logs.mkdir(parents=True, exist_ok=True)
bulk = 'src/main/services/annex-control-bulk.ts'
control = 'src/main/services/annex-control.ts'
stage = 'src/main/services/agent-runtime/chat-attachments.ts'
snapshot = 'src/main/services/handoff-snapshot.ts'
source = 'src/main/services/handoff-transfer-source.ts'
unit = 'src/main/services/annex-control-bulk.test.ts'
transport = 'src/main/services/annex-control.test.ts'
fences = 'src/main/services/annex-binary-fences.test.ts'
staging = 'src/main/services/agent-runtime/chat-attachments.test.ts'
# Each mutation removes a security property; overlapping guards are removed
# together when they enforce the same boundary in more than one layer.
mutants = [
 ('count', bulk, 'this.incoming.size >= BULK_MAX_TRANSFERS', 'false', unit, 'bounds transfer count'),
 ('metadata', bulk, 'Buffer.byteLength(JSON.stringify(frame.meta)) > 16 * 1024', 'false', unit, 'bounds metadata'),
 ('admission', bulk, '!this.hooks.accept(frame.kind!, frame.id, frame.meta!, frame.size!)', 'false', unit, 'checks admission'),
 ('sequence', bulk, 'bytes.readUInt32BE(36) !== t.seq', 'false', unit, 'invalid binary sequence'),
 ('size', bulk, 'body.length !== Math.min(BULK_CHUNK_BYTES, t.size - t.offset)', 'false', unit, 'invalid binary size'),
 ('token', bulk, 'if (!this.cancelled.has(token)) this.hooks.fail();', '', unit, 'invalid binary token'),
 ('digest', bulk, "receiving.hash.digest('hex') !== frame.digest", 'false', unit, 'final digest'),
 ('final-length', bulk, 'receiving.offset !== receiving.size', 'false', unit, 'final length'),
 ('final-owner', bulk, '!this.hooks.accept(receiving.kind, receiving.id, receiving.meta, receiving.size)', 'false', unit, 'final owner'),
 ('frame-authority', bulk, 'if (!this.hooks.allowed()) return;', 'if (false) return;', unit, 'reauthorizes each binary'),
 ('send-authority', bulk, '!this.hooks.allowed() || !t.credit', 'false || !t.credit', unit, 'sends nothing until|actual send authority'),
 ('credit-accumulation', bulk, 'if (sending.credit)', 'if (false)', unit, 'cannot accumulate credits'),
 ('credit-writing', bulk, 't.pumping || t.writing || !t.credit', 't.pumping || !t.credit', unit, 'written callback'),
 ('subscription-owner', control, 'link.subscription?.id === id', 'true', transport, 'forged bulk clipboard-owner'),
 ('clipboard-cap', control, 'size <= CLIPBOARD_IMAGE_MAX_BASE64', 'true', transport, 'forged bulk clipboard-size'),
 ('request-cap', control, 'size <= requestBodyLimit(message.path)', 'true', transport, 'forged bulk request-size|attachment cap'),
 ('direction', control, "link.direction === 'out' && !!link.features?.has('request')", "!!link.features?.has('request')", transport, 'forged bulk direction'),
 ('capability', control, "if (!link.features?.has('bulk'))", 'if (false)', transport, 'forged bulk feature'),
 ('deferred-owner', control, '!stillOwned() || !bulkAllowed(link)', '!bulkAllowed(link)', transport, 'cancels a bulk response'),
 ('deferred-authority', control, '!stillOwned() || !bulkAllowed(link)', '!stillOwned()', transport, 'revocation at a pending binary write'),
 ('staging-before-write', stage, '  await pruneSaved(dir, beforeWrite);\n  beforeWrite();', '  await pruneSaved(dir, beforeWrite);', staging, 'real readdir finishes'),
 ('staging-publication', stage, '    beforeWrite();\n    return remember', '    return remember', staging, 'real realpath finishes'),
 ('clipboard-digest-required', control, "!fromBulk && link.features?.has('bulk') && message.frame.type === 'clipboard:image'", 'false', transport, 'bypass the digest with a legacy JSON client'),
 ('request-digest-required', control, "!fromBulk && link.features?.has('bulk') && binaryPath(message.path) && message.body !== undefined", 'false', transport, 'bypass the digest with a legacy JSON request'),
 ('response-digest-required', control, "message.type === 'response' && message.status >= 200 && message.status < 300 && link.features?.has('bulk') && binaryPath(pending.path)", 'false', transport, 'bypass the digest with a legacy successful JSON answer'),
 ('inactivity-progress', control, 'progress: (id) => link.pending.get(id)?.progress()', 'progress: () => {}', transport, 'bulk progress refreshes request inactivity'),
 ('actual-work-slot', source, 'if (work) void work.then(release, release); else release();', 'release();', 'src/main/services/handoff-transfer-source.test.ts', 'retains a timed-out request slot'),
 ('handoff-inner-read', snapshot, '          beforeRead();', '', fences, 'real handoff descriptor stat await'),
]
paths = [bulk, control, stage, snapshot, source, 'src/main/services/annex-server.ts', 'src/main/services/mobile-attachments.ts', 'src/main/services/handoff-host.ts', 'src/main/services/annex-chat-content.ts', 'src/shared/annex-control-protocol.ts']
original = {p: (root / p).read_bytes() for p in paths}

def run(label, files, pattern):
    cmd = [str(root / 'node_modules/.bin/vitest'), 'run', '--project', 'main', *files, '--maxWorkers=1', '-t', pattern]
    result = subprocess.run(cmd, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    (logs / f'{label}.log').write_text('COMMAND: ' + repr(cmd) + '\n' + result.stdout)
    # A test assertion must fail; import/runtime failures are not killed mutants.
    valid = result.returncode != 0 and ('AssertionError:' in result.stdout or 'expected' in result.stdout)
    print(f'{label}: {"KILLED / expected FAIL" if valid else "SURVIVED / INVALID"}; rc={result.returncode}; {logs / (label + ".log")}', flush=True)
    return valid

ok = True
try:
    if args.only in (None, 'main'):
        for p in paths:
            if p == bulk: continue
            (root / p).write_bytes(subprocess.check_output(['git', 'show', 'origin/main:' + p], cwd=root))
        ok = run('negative-main', [transport, fences, staging], 'P6|binary bulk lane') and ok
        for p, content in original.items(): (root / p).write_bytes(content)
    for label, p, old, new, test, pattern in mutants:
        if args.only and args.only != label: continue
        text = original[p].decode()
        if old not in text:
            print(f'{label}: INVALID source marker absent', flush=True); ok = False; continue
        (root / p).write_text(text.replace(old, new))
        try: ok = run(label, [test], pattern) and ok
        finally: (root / p).write_bytes(original[p])
finally:
    for p, content in original.items(): (root / p).write_bytes(content)
sys.exit(0 if ok else 1)
