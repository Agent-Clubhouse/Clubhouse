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
attempts = root / "docs/evidence/3774-managed-delivery-blocker/attempts"
attempts.mkdir(parents=True, exist_ok=True)
log = attempts / f"{key}-original.txt"
receipt = attempts / f"{key}-receipt.json"
if log.exists() or receipt.exists():
    raise FileExistsError(f"Refusing to replace evidence: {key}")
for prior_path in attempts.glob("*-receipt.json"):
    prior = json.loads(prior_path.read_text())
    ended = datetime.datetime.fromisoformat(prior["finishedAt"])
    if prior["exit"] == 75 and (datetime.datetime.now(datetime.timezone.utc) - ended).total_seconds() < 60:
        raise RuntimeError("Refusal spacing: no gate retry before 60 seconds.")
gate = pathlib.Path.home() / ".clubhouse/orch/desktop-test-gate.sh"
inputs = [
    "src/main/services/managed-agents/delivery.test.ts",
    "src/main/services/managed-agents/delivery.ts",
    "src/main/services/managed-agents/service.ts",
    "src/main/services/managed-agents/state-store.ts",
    "src/main/services/managed-agents/builtins.ts",
    "src/main/services/managed-agents/app-skills/prepare-handoff.ts",
    "src/main/services/asset-catalog/store.ts",
    "src/main/services/asset-catalog/planner.ts",
    "src/main/services/asset-catalog/composer.ts",
    "src/main/services/asset-catalog/validation.ts",
    "src/main/services/settings-audit.ts", "src/main/services/settings-store.ts",
    "src/main/services/base-dir.ts", "src/main/services/agent-wildcards.ts",
    "src/main/services/free-agent-settings.ts", "src/main/services/chat-runtime-settings.ts",
    "src/shared/managed-agents-types.ts", "src/shared/skills-folder.ts",
    "src/__mocks__/electron.ts", "test/global-setup.ts",
    "test/standard-runtime-boundary.ts", "vitest.config.ts",
    "tsconfig.json", "docs/annex-reverse-routes.tsconfig.json",
    "package.json", "package-lock.json",
    "docs/evidence/3774-managed-delivery-blocker/capture.py",
]
inputs.extend(subprocess.check_output([
    "git", "ls-files", "src/main/services/managed-agents/builtin-text",
], cwd=root).decode().splitlines())


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
        "inputs": [{"path": path, "sha256": sha((root / path).read_bytes())} for path in inputs],
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
    "command": invocation, "minimumGiB": int(minimum), "startedAt": started,
    "finishedAt": finished, "before": before, "after": after,
    "inputsUnchanged": before == after, "exit": run.returncode,
    "logSha256": sha(run.stdout), "stderrMergedAtProcessCapture": True,
}, indent=2) + "\n")
sys.stdout.buffer.write(run.stdout)
if before != after:
    raise RuntimeError("Execution inputs changed during command.")
sys.exit(run.returncode)
