"""Run INSIDE desktop-test-gate; record clean head/tree/source before and after a command."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def snapshot():
    report = "docs/evidence/helper-reset-policy/ar1/results.json"
    expected = json.loads((ROOT / report).read_text())["sourceSha256"]
    files = [*expected, report]
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}
    status = git("status", "--porcelain", "--untracked-files=all")
    return {
        "atUtc": datetime.now(timezone.utc).isoformat(),
        "head": git("rev-parse", "HEAD"),
        "tree": git("rev-parse", "HEAD^{tree}"),
        "clean": not status,
        "statusPorcelain": status,
        "sourceSha256": hashes,
        "reportSourceHashesMatched": all(hashes[name] == digest for name, digest in expected.items()),
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
        parser.error("receipt output must be outside the worktree")
    before = snapshot()
    print("VALIDATION_BEFORE=" + json.dumps(before, sort_keys=True), flush=True)
    print("VALIDATION_COMMAND=" + json.dumps(command), flush=True)
    if not before["clean"] or not before["reportSourceHashesMatched"]:
        print("REFUSED: validation requires a clean committed worktree and matching report source hashes", flush=True)
        return 126
    result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    sys.stdout.buffer.write(result.stdout)
    sys.stdout.buffer.flush()
    after = snapshot()
    unchanged = all(before[key] == after[key] for key in ["head", "tree", "sourceSha256"])
    sealed = unchanged and after["clean"] and after["reportSourceHashesMatched"]
    receipt = {
        "schema": 1, "commandArgv": command, "cwd": str(ROOT),
        "before": before, "after": after, "exitCode": result.returncode,
        "rawOutputSha256": hashlib.sha256(result.stdout).hexdigest(),
        "unchanged": unchanged, "sealValid": sealed,
        "passed": sealed and result.returncode == 0,
        "limits": "Before/after seals, not continuous filesystem monitoring or independent review.",
    }
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.with_suffix(".raw.txt").write_bytes(result.stdout)
    stem.with_suffix(".json").write_text(json.dumps(receipt, indent=2) + "\n")
    print("VALIDATION_AFTER=" + json.dumps(after, sort_keys=True), flush=True)
    print("VALIDATION_RESULT=" + json.dumps({key: receipt[key] for key in ["exitCode", "unchanged", "sealValid", "passed"]}), flush=True)
    return result.returncode if sealed else 125


if __name__ == "__main__":
    raise SystemExit(main())
