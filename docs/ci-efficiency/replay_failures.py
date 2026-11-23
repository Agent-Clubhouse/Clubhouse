"""Extract only test paths, timestamp and class from sampled failed job logs.

Usage: python3 docs/ci-efficiency/replay_failures.py
Consumes the committed history-jobs.csv; only reads GitHub, never executes job
contents. Does not attribute all failures to tests. File paths must already
look like repository-relative test/spec names; raw logs are never persisted.
"""
from concurrent.futures import ThreadPoolExecutor
import csv
from pathlib import Path
import re
import subprocess

DATA = Path(__file__).resolve().parent / "data"
ANSI = re.compile(rb"\x1b\[[0-9;]*[A-Za-z]")
TEST = re.compile(rb"(?<![\w./-])((?:src|e2e|test|scripts)/[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?)")
TIME = re.compile(rb"^(\d{4}-\d\d-\d\dT[\d:.]+Z)")


def extract(row):
    url = f"repos/Agent-Clubhouse/Clubhouse/actions/jobs/{row['job_id']}/logs"
    p = subprocess.run(["gh", "api", url], capture_output=True)
    hits = {}
    if not p.returncode:
        for line in p.stdout.splitlines():
            line = ANSI.sub(b"", line).replace(b"\\", b"/")
            stamp = TIME.match(line)
            if not stamp:
                continue
            # Strong reporter signals only. Stack frames, test enumeration,
            # skipped specs and ordinary log mentions are not failures.
            direct = b" FAIL " in line or ("❯".encode() in line and b"failed" in line)
            playwright = re.search(rb"\s\d+\)\s+\[[^\]]+\]\s+.*?\.(?:spec|test)\.", line)
            if direct or playwright:
                for path in TEST.findall(line):
                    hits.setdefault(path.decode(), stamp.group(1).decode())
    return [dict(run_id=row["run_id"], job_id=row["job_id"], os=row["os"],
                 job=row["name"], failure_path=k, first_report_utc=v,
                 evidence="reporter" if k else "unavailable-log" if p.returncode else "no-path-discriminator")
            for k, v in sorted(hits.items()) or [("", "")]]


if __name__ == "__main__":
    with (DATA / "history-jobs.csv").open() as src:
        jobs = [r for r in csv.DictReader(src) if r["workflow"] == "Validate" and
                r["event"] in ("push", "pull_request") and r["conclusion"] == "failure"]
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows = [r for batch in pool.map(extract, jobs) for r in batch]
    with (DATA / "replay-failures.csv").open("w") as out:
        wr = csv.DictWriter(out, rows[0], lineterminator="\n")
        wr.writeheader()
        wr.writerows(rows)
