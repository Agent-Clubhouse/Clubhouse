"""Recover immutable event diff bases for sampled Validate pushes and PRs.

Only the SHA values from Plan the run's environment are kept. Raw logs are
streamed through memory, never saved or printed. No checkout or hosted run.
Run after collecting data/history-*.csv. Missing logs stay unresolved.
"""
import argparse
import csv
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
PARSER = re.compile(rb"^\S+\s+(PR_BASE|PR_HEAD|PUSH_BEFORE|HEAD): ([0-9a-f]{40})\s*$", re.M)
REPO = "Agent-Clubhouse/Clubhouse"


def recover(pair):
    row, job_id = pair
    out = dict(run_id=row["run_id"], event=row["event"], conclusion=row["conclusion"],
               plan_job_id=job_id, base="", head=row["head_sha"], source="no-plan")
    if not job_id:
        return out
    proc = subprocess.run(["gh", "api", f"repos/{REPO}/actions/jobs/{job_id}/logs"],
                          capture_output=True)
    if proc.returncode:
        out["source"] = "log-unavailable"
        return out
    env = {k.decode(): v.decode() for k, v in PARSER.findall(proc.stdout)}
    if row["event"] == "pull_request":
        if env.get("PR_HEAD") == row["head_sha"] and env.get("PR_BASE"):
            out.update(base=env["PR_BASE"], source="plan-PR_BASE")
        else:
            out["source"] = "missing-or-mismatched-pr-context"
    elif env.get("PUSH_BEFORE") and env["PUSH_BEFORE"] != "0" * 40:
        out.update(base=env["PUSH_BEFORE"], source="plan-PUSH_BEFORE")
    else:
        out["source"] = "missing-push-before"
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=HERE / "data")
    args = parser.parse_args()
    with (args.input_dir / "history-jobs.csv").open() as fp:
        plans = {r["run_id"]: r["job_id"] for r in csv.DictReader(fp)
                 if r["name"] == "Plan the run" and r["conclusion"] == "success"}
    with (args.input_dir / "history-validate-replay.csv").open() as fp:
        batch = [(r, plans.get(r["run_id"], "")) for r in csv.DictReader(fp)
                 if r["event"] in {"pull_request", "push"}]
    with ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(recover, batch))
    with (HERE / "data/replay-context.csv").open("w") as fp:
        writer = csv.DictWriter(fp, records[0], lineterminator="\n")
        writer.writeheader()
        writer.writerows(records)


if __name__ == "__main__":
    main()
