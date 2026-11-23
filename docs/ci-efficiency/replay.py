"""Apply the advisory selector to exact immutable Actions event diff contexts.

Run from any directory in the checkout. Historical PR objects can disappear
from ordinary fetches. Use --fetch-missing for a read-only, SHA-pinned git
fetch into the object store (no worktree checkout or remote branch writes).
Without those objects, an event remains an explicit full fallback.
"""
import argparse
from collections import Counter, defaultdict
import csv
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = HERE / "data"
SHA = re.compile("[0-9a-f]{40}")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, stderr=subprocess.DEVNULL)


def read(name):
    with (DATA / name).open() as fp:
        return list(csv.DictReader(fp))


def exists(sha):
    return bool(SHA.fullmatch(sha)) and not subprocess.run(
        ["git", "cat-file", "-e", sha + "^{commit}"], cwd=ROOT, capture_output=True).returncode


def compare(row, selector, failures):
    failed = {f["failure_path"] for f in failures if f["failure_path"]}
    summary = dict(run_id=row["run_id"], event=row["event"], conclusion=row["conclusion"],
                   mode="full", reason=row["source"], diff_base="", changed_count="",
                   unit_files_proposed="", failed_paths=len(failed), directory_rule_misses="",
                   shadow_known_file_omissions="", failures_without_file=len(
                       {f["job_id"] for f in failures if not f["failure_path"]}))
    if not row["base"] or not all(exists(row[k]) for k in ["base", "head"]):
        if row["base"]:
            summary["reason"] = "missing-git-object"
        return summary
    base, head = row["base"], row["head"]
    if row["event"] == "pull_request":
        bases = git("merge-base", "--all", base, head).decode().splitlines()
        if len(bases) != 1:
            summary["reason"] = "ambiguous-merge-base"
            return summary
        base = bases[0]
    elif subprocess.run(["git", "merge-base", "--is-ancestor", base, head], cwd=ROOT).returncode:
        summary["reason"] = "non-ancestor-push"
        return summary
    paths = {p for p in git("diff", "--no-renames", "--name-only", "-z", base, head).decode().split("\0") if p}
    decision = json.loads(subprocess.check_output(
        ["node", str(selector), "--repo", str(ROOT), "--base", base, "--head", head], cwd=ROOT))
    assert decision["reportOnly"] and decision["mode"] in ("full", "selected")
    dirs = {str(Path(path).parent) for path in paths}
    # Deliberately weak comparison: exactly the directory of an edited file.
    directory_misses = sum(str(Path(path).parent) not in dirs for path in failed)
    # The policy only proposes changes to unit selection. E2E jobs stay.
    unit_failures = {f["failure_path"] for f in failures if f["failure_path"] and
                     (f["job"].startswith("Unit + Component Tests") or f["job"] == "macOS unit")}
    omitted = (unit_failures - set(decision["tests"])) if decision["mode"] == "selected" else set()
    return {**summary, "mode": decision["mode"], "reason": decision["reasons"][0].split(":")[0],
            "diff_base": base, "changed_count": len(paths),
            "unit_files_proposed": len(decision["tests"]) if decision["mode"] == "selected" else "",
            "directory_rule_misses": directory_misses, "shadow_known_file_omissions": len(omitted)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--fetch-missing", action="store_true")
    p.add_argument("--selector", type=Path, default=ROOT / "scripts/ci/affected-shadow.mjs")
    args = p.parse_args()
    rows = read("replay-context.csv")
    if args.fetch_missing:
        missing = sorted({r[key] for r in rows if r["base"] for key in ("base", "head")
                          if SHA.fullmatch(r[key]) and not exists(r[key])})
        if missing:
            subprocess.run(["git", "fetch", "--no-tags", "--no-write-fetch-head", "origin", *missing], cwd=ROOT)
    failures = defaultdict(list)
    for f in read("replay-failures.csv"):
        failures[f["run_id"]].append(f)
    results = [compare(r, args.selector.resolve(), failures[r["run_id"]]) for r in rows]
    with (DATA / "selector-replay.csv").open("w") as fp:
        writer = csv.DictWriter(fp, results[0], lineterminator="\n")
        writer.writeheader()
        writer.writerows(results)
    print(Counter((r["mode"], r["reason"]) for r in results))


if __name__ == "__main__":
    main()
