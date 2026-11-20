"""Run inside desktop-test-gate; seal exact committed source before and after one validation command."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
BASE = "f386b143fda60d969c705dcb397c9458b6ae0035"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def snapshot():
    files = set(git("diff", "--name-only", BASE, "HEAD").splitlines())
    files.update(["package-lock.json", "tsconfig.json", "vitest.config.ts",
                  "src/main/services/provider-quota.ts", "src/main/services/helper-burn-pressure.ts",
                  "src/shared/helper-burn-pressure.ts", "src/main/services/agent-helpers.ts"])
    status = git("status", "--porcelain", "--untracked-files=all")
    return {
        "atUtc": datetime.now(timezone.utc).isoformat(), "head": git("rev-parse", "HEAD"),
        "tree": git("rev-parse", "HEAD^{tree}"), "clean": not status, "statusPorcelain": status,
        "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(files)},
        "fixtureProfile": os.environ.get("ANNEX_MOBILE_ROUTING_FIXTURES"),
        "nodeVersion": subprocess.check_output(["node", "--version"], text=True).strip(),
        "localDependencyLinks": sum(path.is_symlink() for path in (ROOT / "node_modules").iterdir()),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-stem", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required")
    stem = Path(args.output_stem).resolve()
    if stem.is_relative_to(ROOT):
        parser.error("write receipts outside the worktree")
    before = snapshot()
    print("VALIDATION_BEFORE=" + json.dumps(before, sort_keys=True), flush=True)
    print("VALIDATION_COMMAND=" + json.dumps(command), flush=True)
    if not before["clean"]:
        print("REFUSED: validation requires a clean committed worktree", flush=True)
        return 126
    result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    sys.stdout.buffer.write(result.stdout)
    sys.stdout.buffer.flush()
    after = snapshot()
    unchanged = all(before[key] == after[key] for key in ["head", "tree", "sourceSha256", "fixtureProfile", "nodeVersion", "localDependencyLinks"])
    sealed = unchanged and after["clean"]
    receipt = {"schema": 1, "commandArgv": command, "cwd": str(ROOT), "before": before, "after": after,
               "exitCode": result.returncode, "unchanged": unchanged, "sealValid": sealed,
               "passed": sealed and result.returncode == 0,
               "rawOutputSha256": hashlib.sha256(result.stdout).hexdigest(),
               "limits": "Before/after seals, not continuous monitoring or independent review. Dependencies use a byte-matched existing cache through reversible local links."}
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.with_suffix(".raw.txt").write_bytes(result.stdout)
    stem.with_suffix(".json").write_text(json.dumps(receipt, indent=2) + "\n")
    print("VALIDATION_AFTER=" + json.dumps(after, sort_keys=True), flush=True)
    print("VALIDATION_RESULT=" + json.dumps({key: receipt[key] for key in ["exitCode", "unchanged", "sealValid", "passed"]}), flush=True)
    return result.returncode if sealed else 125


if __name__ == "__main__":
    raise SystemExit(main())
