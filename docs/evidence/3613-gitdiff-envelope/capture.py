import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import sys


key, minimum, *command = sys.argv[1:]
if not re.fullmatch(r"\d{2}-[a-z-]+", key) or minimum not in ("4", "6") or not command:
    raise ValueError("Usage: python3 capture.py NN-name 4|6 command ...")
root = pathlib.Path.cwd()
attempts = root / "docs/evidence/3613-gitdiff-envelope/attempts"
attempts.mkdir(parents=True, exist_ok=True)
log = attempts / f"{key}-original.txt"
receipt = attempts / f"{key}-receipt.json"
if log.exists() or receipt.exists():
    raise FileExistsError(f"Refusing to replace evidence: {key}")
for prior_path in attempts.glob("*-receipt.json"):
    prior = json.loads(prior_path.read_text())
    ended = datetime.datetime.fromisoformat(prior["finishedAt"])
    if prior["exit"] == 75 and (datetime.datetime.now(datetime.timezone.utc) - ended).total_seconds() < 60:
        raise RuntimeError("No refusal retry before60s; changed holder evidence also required.")
gate = pathlib.Path.home() / ".clubhouse/orch/desktop-test-gate.sh"
inputs = [
    "src/main/services/annex-control.ts", "src/main/services/annex-control.test.ts",
    "src/main/services/annex-control-bulk.ts", "src/main/services/annex-control-bulk.test.ts",
    "src/main/services/annex-authorizer.ts", "src/shared/annex-control-protocol.ts",
    "src/shared/annex-control-protocol.test.ts", "src/main/services/annex-client.ts",
    "src/main/services/annex-client.test.ts", "src/main/services/annex-server.ts",
    "src/main/services/annex-server.test.ts",
    "src/main/services/git-service.ts", "src/shared/annex-binary-limits.ts",
    "src/shared/icon-limits.ts", "src/shared/chat/index.ts", "src/shared/chat/attachments.ts",
    "src/main/services/annex-full-events.ts", "src/shared/handoff-transfer.ts",
    "src/main/services/annex-routes.ts", "src/shared/annex-problems.ts", "src/shared/types.ts",
    "src/main/services/annex-tls.ts", "src/main/services/annex-device-signal.ts",
    "src/main/services/log-service.ts", "test/global-setup.ts", "test/standard-runtime-boundary.ts",
    "vitest.config.ts", "tsconfig.json", "docs/annex-reverse-routes.tsconfig.json",
    "package.json", "package-lock.json", "docs/evidence/3613-gitdiff-envelope/capture.py",
]
fixture_config = "docs/evidence/3613-gitdiff-envelope/fixture-tsconfig.json"
if (root / fixture_config).exists():
    inputs.append(fixture_config)
installed = [
    "node_modules/@vitest/runner/dist/chunk-artifact.js",
    "node_modules/@vitest/runner/package.json", "node_modules/vitest/package.json",
    "node_modules/typescript/package.json", "node_modules/eslint/package.json",
]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=root)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def seal():
    return {
        "head": git("rev-parse", "HEAD").decode().strip(),
        "tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "trackedStatus": git("status", "--porcelain=v1", "--untracked-files=no").decode(),
        "trackedDiffSha256": sha(git("diff", "HEAD", "--binary")),
        "gateSha256": sha(gate.read_bytes()),
        "runtime": {"node": subprocess.check_output(["node", "--version"]).decode().strip(),
                    "platform": sys.platform},
        "inputs": [{"path": path, "sha256": sha((root / path).read_bytes())} for path in inputs],
        "installed": [{"path": path, "sha256": sha((root / path).read_bytes())} for path in installed],
    }


before = seal()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
invocation = [str(gate), "lane-p2", minimum, "--", *command]
run = subprocess.run(invocation, cwd=root, stdin=subprocess.DEVNULL,
                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
finished = datetime.datetime.now(datetime.timezone.utc).isoformat()
after = seal()
log.write_bytes(run.stdout)
receipt.write_text(json.dumps({
    "command": ["~/.clubhouse/orch/desktop-test-gate.sh", *invocation[1:]],
    "gatePathRenderedWithHomeAlias": True,
    "minimumGiB": int(minimum), "startedAt": started, "finishedAt": finished,
    "before": before, "after": after, "inputsUnchanged": before == after,
    "exit": run.returncode, "logSha256": sha(run.stdout), "stderrMergedAtProcessCapture": True,
}, indent=2) + "\n")
sys.stdout.buffer.write(run.stdout)
if before != after:
    raise RuntimeError("Execution inputs changed during command.")
sys.exit(run.returncode)
