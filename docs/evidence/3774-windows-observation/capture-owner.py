import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile


repo = "Agent-Clubhouse/Clubhouse"
head = "30f8287ccdc8241c3bc046c9ef3dd5833230cbf0"
root = pathlib.Path("node_modules/.cache/3774-windows-observation-30f")
root.mkdir(parents=True, exist_ok=False)
env = dict(os.environ, GH_PAGER="cat", PAGER="cat", GH_PROMPT_DISABLED="1")


def gh(*args):
    return subprocess.check_output(["gh", *args], env=env)


run = None
for attempt in range(5):
    runs = json.loads(gh("run", "list", "--repo", repo, "--commit", head,
                         "--event", "pull_request", "--workflow", "Validate", "--limit", "5",
                         "--json", "databaseId,headSha,event,status,conclusion,createdAt,url"))
    assert len(runs) <= 1, "Multiple automatic runs: refuse duplicate observation"
    if runs:
        run = runs[0]
        break
    if attempt < 4:
        time.sleep(15)
if run is None:
    (root / "registration-stall.json").write_text(json.dumps({
        "head": head, "reason": "No automatic Validate run registered within bounded60s discovery",
    }, indent=2) + "\n")
    sys.exit("REGISTRATION STALL: no automatic exact-head run; no dispatch/rerun")

run_id = str(run["databaseId"])
metadata = json.loads(gh("api", f"repos/{repo}/actions/runs/{run_id}"))
assert metadata["head_sha"] == head and metadata["event"] == "pull_request"
assert metadata["run_attempt"] == 1
(root / "registration.json").write_text(json.dumps(metadata, indent=2) + "\n")
print(f"OWNED WATCH START run={run_id} head={head} parentPID={os.getpid()}", flush=True)
with (root / "watch-original.txt").open("wb") as output:
    watcher = subprocess.Popen(["gh", "run", "watch", run_id, "--repo", repo,
                                "--exit-status", "--interval", "60"],
                               stdout=output, stderr=subprocess.STDOUT, env=env)
    print(f"OWNED WATCH PID={watcher.pid} run={run_id}", flush=True)
    watch_exit = watcher.wait()
terminal = json.loads(gh("api", f"repos/{repo}/actions/runs/{run_id}"))
assert terminal["head_sha"] == head and terminal["run_attempt"] == 1
(root / "terminal.json").write_text(json.dumps(terminal, indent=2) + "\n")
if terminal["status"] != "completed":
    sys.exit(f"WATCH STALL run={run_id} watchExit={watch_exit} actualStatus={terminal['status']}")
jobs = json.loads(gh("api", f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100"))
assert jobs["total_count"] == len(jobs["jobs"])
(root / "jobs.json").write_text(json.dumps(jobs, indent=2) + "\n")
job = next(job for job in jobs["jobs"]
           if job["name"] == "Unit + Component Tests (windows-latest, 2/2)")
raw = gh("run", "view", run_id, "--repo", repo, "--job", str(job["id"]), "--log")
(root / "windows-shard2-original.log").write_bytes(raw)
artifacts = json.loads(gh("api", f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100"))
assert artifacts["total_count"] == len(artifacts["artifacts"])
(root / "artifacts.json").write_text(json.dumps(artifacts, indent=2) + "\n")
artifact = next(item for item in artifacts["artifacts"]
                if item["name"] == "test-results-windows-latest-2")
archive = gh("api", f"repos/{repo}/actions/artifacts/{artifact['id']}/zip")
(root / "windows-shard2-junit-original.zip").write_bytes(archive)
with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
    names = zipped.namelist()
    assert names == ["test-results.xml"], f"Unexpected JUnit archive entries: {names}"
    xml = zipped.read("test-results.xml")
(root / "windows-shard2-junit-original.xml").write_bytes(xml)
tree = ET.fromstring(xml)
cases = [case for case in tree.iter("testcase")
         if "does not claim installation of a grant-gated skill left to the project (#3517)"
         in case.attrib["name"]]
assert len(cases) == 1, "Exact target missing or duplicated in Windows shard2 JUnit"
case = cases[0]
prefix = "CLUBHOUSE_MANAGED_PHASE_V1 "
frames = [json.loads(line[len(prefix):])
          for line in (case.findtext("system-err") or "").splitlines()
          if line.startswith(prefix)]
failures = [item.attrib for item in case if item.tag in ("failure", "error")]
raw_frames = [json.loads(line[line.index(prefix) + len(prefix):].strip())
              for line in raw.decode().splitlines() if prefix in line]
summary = {
    "run": int(run_id), "head": head, "runAttempt": terminal["run_attempt"],
    "status": terminal["status"], "conclusion": terminal["conclusion"], "watchExit": watch_exit,
    "windowsJob": {"id": job["id"], "conclusion": job["conclusion"]},
    "target": case.attrib, "targetFailures": failures, "actualJUnitPhasePackets": frames,
    "packetDisposition": ("absent" if not frames else
                          "unavailable" if any(frame.get("observerUnavailable") for frame in frames) else "full"),
    "rawContainsEveryJUnitPacket": bool(frames) and all(frame in raw_frames for frame in frames),
    "rawSha256": hashlib.sha256(raw).hexdigest(), "junitSha256": hashlib.sha256(xml).hexdigest(),
    "junitArchiveSha256": hashlib.sha256(archive).hexdigest(),
    "scope": "one automatic observation; no prior timeout cause/flake/fix/landing inference",
}
(root / "observation.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2), flush=True)
