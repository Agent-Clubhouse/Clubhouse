"""Read-only release job audit. Run with Python 3.9+ and authenticated gh.

python3 docs/ci-efficiency/release_usage.py --fetch  # replaces release-jobs.csv
python3 docs/ci-efficiency/release_usage.py          # offline, summarize CSV
"""
import argparse
import csv
from datetime import datetime
from itertools import count
import json
from pathlib import Path
import statistics
import subprocess

HERE = Path(__file__).resolve().parent
DATA = HERE / "release-jobs.csv"
REPO = "Agent-Clubhouse/Clubhouse"
WINDOW = "2026-10-25T00:00:00Z..2026-11-23T23:29:00Z"
FIELDS = ("run_id", "tag", "attempt", "job_id", "job", "outcome", "start_utc",
          "end_utc", "seconds", "install_s", "forge_sign_notarize_s", "upload_s",
          "setup_job_s", "ready_to_start_s")


def seconds(start, end):
    def parse(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return int((parse(end) - parse(start)).total_seconds())


def pages(endpoint, field):
    for page in count(1):
        separator = "&" if "?" in endpoint else "?"
        url = f"repos/{REPO}/{endpoint}{separator}per_page=100&page={page}"
        response = json.loads(subprocess.check_output(["gh", "api", url]))
        yield from response[field]
        if page * 100 >= response["total_count"]:
            return


def read_jobs():
    runs = pages(f"actions/workflows/release.yml/runs?created={WINDOW}", "workflow_runs")
    for run in runs:
        jobs = sorted(pages(f"actions/runs/{run['id']}/jobs?filter=all", "jobs"),
                      key=lambda j: (j["run_attempt"], j["id"]))
        seen = set()
        for job in jobs:
            if not any("macos" in label.lower() for label in job["labels"]):
                continue
            start, end = job["started_at"], job["completed_at"]
            if not end or job["conclusion"] == "skipped":
                continue
            stamp = (job["name"], start, end)
            if stamp in seen:
                continue
            seen.add(stamp)
            steps = {s["name"]: seconds(s["started_at"], s["completed_at"])
                     for s in job["steps"] if s.get("started_at") and s.get("completed_at")
                     and s["conclusion"] != "skipped"}
            # First attempts only: a lower bound on dependency readiness for
            # the two historical Release job families. Leave retries unestimated.
            gates = [j["completed_at"] for j in jobs if j["run_attempt"] == 1
                     and j["conclusion"] == "success" and (j["name"] == "Verify Tag" or
                     (job["name"].startswith("Build macOS") and
                      j["name"].startswith("Validate Update Scripts")))]
            ready = seconds(max(gates), start) if gates and job["run_attempt"] == 1 else None
            yield dict(zip(FIELDS, (run["id"], run["head_branch"], job["run_attempt"], job["id"],
                    job["name"], job["conclusion"], start, end, seconds(start, end),
                    steps.get("Install dependencies", steps.get("Run npm ci", 0)),
                    steps.get("Build, sign, and notarize", 0), steps.get("Upload build artifacts", 0),
                    steps.get("Set up job", 0), ready if ready is not None and ready >= 0 else "")))


def summarize(rows):
    for name in sorted({r["job"] for r in rows}):
        group = [r for r in rows if r["job"] == name]
        waits = [int(r["ready_to_start_s"]) for r in group if r["ready_to_start_s"] != ""]
        print(name, "executions", len(group), "minutes",
              {f: round(sum(int(r[f]) for r in group) / 60, 1)
               for f in ("seconds", "install_s", "forge_sign_notarize_s", "upload_s", "setup_job_s")},
              "median first-attempt eligible delay (s)", statistics.median(waits) if waits else None)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch", action="store_true")
    if parser.parse_args().fetch:
        records = list(read_jobs())
        with DATA.open("w") as out:
            writer = csv.DictWriter(out, FIELDS, lineterminator="\n")
            writer.writeheader()
            writer.writerows(records)
    with DATA.open() as src:
        summarize(list(csv.DictReader(src)))
