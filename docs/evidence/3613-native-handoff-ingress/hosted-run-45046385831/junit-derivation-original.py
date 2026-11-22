import gzip
import hashlib
import json
import re
from pathlib import Path
import xml.etree.ElementTree as ET

root = Path("node_modules/.cache/native-handoff-ingress")
results = []
for source in sorted((root / "42-hosted-junit-original").glob("*/test-results.xml")):
    raw = source.read_bytes()
    tree = ET.fromstring(raw)
    cases = []
    for case in tree.iter("testcase"):
        failure = case.find("failure")
        error = case.find("error")
        skipped = case.find("skipped")
        status = "failure" if failure is not None else "error" if error is not None else "skipped" if skipped is not None else "passed"
        item = {"name": case.get("name"), "classname": case.get("classname"), "status": status}
        if failure is not None:
            item["failure"] = {"attributes": failure.attrib, "text": failure.text}
        if error is not None:
            item["error"] = {"attributes": error.attrib, "text": error.text}
        cases.append(item)
    selected = [case for case in cases if case["status"] in ("failure", "error") or any(part in (case["classname"] or "") for part in ("annex-server.test", "annex-native-handoff-admission.test", "handoff-host.test", "handoff-coordinator.test", "handoff-service.test"))]
    counts = {status: sum(case["status"] == status for case in cases) for status in ("passed", "failure", "error", "skipped")}
    results.append({"artifact": source.parent.name, "rawBytes": len(raw), "rawSha256": hashlib.sha256(raw).hexdigest(), "rootAttributes": tree.attrib, "counts": counts, "selected": selected})
(root / "43-junit-derived.json").write_text(json.dumps(results, indent=2) + "\n")
for result in results:
    print(json.dumps({"artifact": result["artifact"], "counts": result["counts"], "failures": [case["name"] for case in result["selected"] if case["status"] in ("failure", "error")]}))

raw_log = (root / "40-logs-original.log").read_bytes()
assert gzip.decompress((root / "40-logs-original.log.gz").read_bytes()) == raw_log
lines = raw_log.decode().splitlines()
checkouts = []
for index, line in enumerate(lines[:-1]):
    if re.search(r'git(?:\.exe)?"? log -1 --format=%H', line):
        match = re.search(r"\b[0-9a-f]{40}\b", lines[index + 1])
        assert match is not None, line
        checkouts.append({"job": line.split("\t")[0], "sha": match.group(), "commandLine": index + 1, "resultLine": index + 2})
assert len(checkouts) == 33
assert all(item["sha"] == "99fee0f0149e2ba0f83735aa947b52c9fef1873f" for item in checkouts)
(root / "43-checkouts-derived.json").write_text(json.dumps({"rawLogSha256": hashlib.sha256(raw_log).hexdigest(), "checkouts": checkouts, "note": "Separate complete Windows/Unix derivation from same original logs; initial Linux-only packet preserved."}, indent=2) + "\n")
print(json.dumps({"actualCheckouts": len(checkouts), "uniqueSha": sorted({item["sha"] for item in checkouts})}))
