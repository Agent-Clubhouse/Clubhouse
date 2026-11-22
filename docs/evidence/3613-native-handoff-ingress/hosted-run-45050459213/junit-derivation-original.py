import gzip
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

root = Path("node_modules/.cache/native-handoff-ingress")
old_green = Path("docs/evidence/3613-native-handoff-ingress/hosted-fixture-correction/artifacts/46-fixture-green-original.xml.gz")
prior = ET.fromstring(gzip.decompress(old_green.read_bytes()))
required_names = {case.get("name") for case in prior.iter("testcase") if case.find("skipped") is None and case.find("failure") is None}
assert len(required_names) == 5
rows = []
for source in sorted((root / "61-newhead-junit-original").glob("*/test-results.xml")):
    raw = source.read_bytes()
    tree = ET.fromstring(raw)
    cases = []
    for case in tree.iter("testcase"):
        failure = case.find("failure")
        error = case.find("error")
        skipped = case.find("skipped")
        status = "failure" if failure is not None else "error" if error is not None else "skipped" if skipped is not None else "passed"
        cases.append({"name": case.get("name"), "classname": case.get("classname"), "status": status})
    counts = {status: sum(case["status"] == status for case in cases) for status in ("passed", "failure", "error", "skipped")}
    assert counts["failure"] == 0 and counts["error"] == 0
    selected = [case for case in cases if case["name"] in required_names or "annex-native-handoff-admission.test" in (case["classname"] or "")]
    rows.append({"artifact": source.parent.name, "rawBytes": len(raw), "rawSha256": hashlib.sha256(raw).hexdigest(), "rootAttributes": tree.attrib, "counts": counts, "selected": selected})
assert len(rows) == 4
platforms = {}
for platform in ("ubuntu", "windows"):
    selected = [case for row in rows if platform in row["artifact"] for case in row["selected"]]
    required = [case for case in selected if case["name"] in required_names]
    native = [case for case in selected if "annex-native-handoff-admission.test" in (case["classname"] or "")]
    assert len(required) == 5 and all(case["status"] == "passed" for case in required)
    assert len(native) == 21 and all(case["status"] == "passed" for case in native)
    platforms[platform] = {"requiredFiveCases": required, "nativeCaseCount": len(native), "allSelectedPassed": True}
packet = {"run": 45050459213, "head": "e83d9f27f0e6a85f3a2791b1eadb85995c6ae701", "artifacts": rows, "platforms": platforms, "note": "Actual hosted XML at e83, separate from original local five-case60ed run and historical35/8/1 scopes. No new compiler or broader product acceptance."}
(root / "63-newhead-junit-derived.json").write_text(json.dumps(packet, indent=2) + "\n")
print(json.dumps({"run": packet["run"], "shards": [{"artifact": row["artifact"], "counts": row["counts"]} for row in rows], "platforms": {name: {"requiredFivePassed": len(value["requiredFiveCases"]), "nativeCasesPassed": value["nativeCaseCount"]} for name, value in platforms.items()}}))
