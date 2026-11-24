import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

cwd = Path(sys.argv[1]).resolve()
prefix = Path(sys.argv[2]).resolve()
minimum = int(sys.argv[3])
command = sys.argv[4:]
gate = Path.home() / ".clubhouse/orch/desktop-test-gate.sh"
inputs = [
    "src/main/services/annex-client.ts",
    "src/main/services/annex-client.test.ts",
    "src/main/services/annex-control.ts",
    "src/main/services/annex-control.test.ts",
    "src/main/services/annex-control-bulk.ts",
    "src/main/services/annex-devices.ts",
    "src/main/services/annex-devices.test.ts",
    "src/main/services/annex-client-buffer.test.ts",
    "src/main/services/handoff-transfer-source.test.ts",
    "src/main/services/handoff-transfer-source.ts",
    "src/shared/handoff-transfer.ts",
    "node_modules/.cache/3772-buffer-equality-fixture.tsconfig.json",
    "src/main/services/remote-icon-fetch.ts",
    "src/main/services/remote-icon-fetch.test.ts",
    "test/annex-v2/annex-reverse-consumers.test.ts",
    "docs/evidence/3613-duplex-consumer-candidate/lint-baseline.mjs",
    "src/main/ipc/annex-handlers.ts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "eslint.config.mjs",
    "docs/annex-reverse-routes.tsconfig.json",
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=cwd)


def seal():
    files = set(inputs)
    files.update(git("diff", "--name-only", "HEAD").decode().splitlines())
    files.update(git("ls-files", "--others", "--exclude-standard").decode().splitlines())
    return {
        "head": git("rev-parse", "HEAD").decode().strip(),
        "tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "status": git("status", "--porcelain").decode(),
        "diffSha256": sha(git("diff", "--binary", "HEAD")),
        "sha256": {name: sha((cwd / name).read_bytes()) for name in sorted(files) if (cwd / name).is_file()},
    }


raw = prefix.with_name(prefix.name + "-original.txt")
receipt = prefix.with_name(prefix.name + "-receipt.json")
if raw.exists() or receipt.exists():
    raise FileExistsError(f"Preserve original attempt: {prefix}")
before = seal()
gate_before = sha(gate.read_bytes())
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
with raw.open("xb") as output:
    result = subprocess.run([str(gate), "lane-p2", str(minimum), "--", *command], cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
ended = datetime.datetime.now(datetime.timezone.utc).isoformat()
after = seal()
gate_after = sha(gate.read_bytes())
text = raw.read_bytes()
record = {
    "schemaVersion": 1,
    "producerSha256": sha(Path(__file__).read_bytes()),
    "attempt": prefix.name,
    "cwd": str(cwd),
    "command": command,
    "gate": str(gate),
    "minimum": minimum,
    "gateSha256Before": gate_before,
    "gateSha256After": gate_after,
    "startedUtc": started,
    "endedUtc": ended,
    "sourceBefore": before,
    "sourceAfter": after,
    "exitCode": result.returncode,
    "admissionObserved": bool(re.search(rb" START lane-p2 ", text)),
    "sourceAndGateStable": before == after and gate_before == gate_after,
    "rawOutput": raw.name,
    "rawSha256": sha(text),
}
with receipt.open("x") as output:
    json.dump(record, output, indent=2)
    output.write("\n")
print(text.decode(errors="replace")[-18000:])
print(json.dumps({key: record[key] for key in ["attempt", "exitCode", "admissionObserved", "sourceAndGateStable", "rawSha256"]}))
sys.exit(result.returncode)
