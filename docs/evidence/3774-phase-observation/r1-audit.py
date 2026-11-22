import hashlib
import json
import pathlib
import subprocess
import tempfile
import xml.etree.ElementTree as ET


root = pathlib.Path("docs/evidence/3774-phase-observation")
attempts = root / "attempts"
fixture = pathlib.Path("src/main/services/managed-agents/delivery.test.ts")
source = "15f54f5ec7eac7e6d8ef0f14a730d8dac4413181"
prefix = "CLUBHOUSE_MANAGED_PHASE_V1 "
keys = ["08-final-output-red", "09-final-output-fixed", "10-rone-types-lint", "11-rone-exact-target"]
receipts = {}
summaries = []
for key in keys:
    receipt = json.loads((attempts / f"{key}-receipt.json").read_text())
    assert receipt["inputsUnchanged"] and receipt["before"] == receipt["after"]
    assert hashlib.sha256((attempts / f"{key}-original.txt").read_bytes()).hexdigest() == receipt["logSha256"]
    receipts[key] = receipt
    if key.startswith("10-"):
        assert receipt["exit"] == 0 and receipt["minimumGiB"] == 6
        summaries.append({"key": key, "exit": 0, "types": "PASS", "lint": "PASS"})
        continue
    cases = list(ET.parse(attempts / f"{key}.xml").iter("testcase"))
    selected = [case for case in cases if case.find("skipped") is None]
    failures = [case for case in selected if case.find("failure") is not None]
    assert len(cases) - len(selected) == 67
    expected_failures = 2 if key.startswith("08-") else 0
    assert len(failures) == expected_failures
    assert len(selected) == (1 if key.startswith("11-") else 3)
    raw = [json.loads(line[len(prefix):])
           for line in (attempts / f"{key}-original.txt").read_text().splitlines() if line.startswith(prefix)]
    frames = {}
    for case in selected:
        values = [json.loads(line[len(prefix):])
                  for line in (case.findtext("system-err") or "").splitlines() if line.startswith(prefix)]
        assert len(values) == 1 and values[0] in raw
        assert len(json.dumps(values[0]).encode()) < 16_384
        frames[case.attrib["name"]] = values[0]
    if not key.startswith("11-"):
        value = next(value for name, value in frames.items() if "final raw write only" in name)
        if key.startswith("08-"):
            assert value["observerFailures"] == 0 and value["observerUnavailable"] is False
        else:
            assert value == {"version": 1, "observerUnavailable": True}
    target = next(value for name, value in frames.items() if "(#3517)" in name)
    assert target["observerFailures"] == 0 and target["observerUnavailable"] is False
    assert len(target["transitions"]) == 20 and target["final"]["active"] == []
    summaries.append({
        "key": key, "passed": len(selected) - len(failures), "failed": len(failures),
        "skipped": 67, "actualJUnitPackets": len(frames), "packetInActualMergedRaw": True,
    })

restored = receipts["10-rone-types-lint"]["before"]
assert restored == receipts["11-rone-exact-target"]["before"]
assert restored["head"] == source and restored["trackedStatus"] == ""
assert all(hashlib.sha256(pathlib.Path(item["path"]).read_bytes()).hexdigest() == item["sha256"]
           for item in restored["inputs"])
assert subprocess.check_output(["git", "show", f"{source}:{fixture}"]) == fixture.read_bytes()
base = subprocess.check_output(["git", "show", f"43a20457f8091ebe5d450b6e52953ec30d005554:{fixture}"])
bridges = []
with tempfile.TemporaryDirectory(dir="node_modules/.cache", prefix="3774-r1-byte-bridge-") as directory:
    work = pathlib.Path(directory)
    target = work / fixture
    target.parent.mkdir(parents=True)
    for key, patch in [
        ("08-final-output-red", "08-final-output-controls.patch"),
        ("09-final-output-fixed", "09-final-output-fixed-controls.patch"),
    ]:
        target.write_bytes(base)
        subprocess.run(["git", "apply", "--directory", directory, str(root / patch)], check=True)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        assert digest == next(item["sha256"] for item in receipts[key]["before"]["inputs"]
                              if item["path"] == str(fixture))
        bridges.append({"key": key, "archivedPatchReconstructsExecutedFixtureSha256": digest})
    subprocess.run(["git", "apply", "--reverse", "--directory", directory,
                    str(root / "08-final-output-controls.patch")], check=True)
    assert target.read_bytes() == fixture.read_bytes()

manifest_bytes = (root / "manifest.json").read_bytes()
assert hashlib.sha256(manifest_bytes).hexdigest() == "99438287d9668360f0bdd332641c4a2041cfd98a3fa4536d082672787638499d"
old_manifest = json.loads(manifest_bytes)
for artifact in old_manifest["artifacts"]:
    data = pathlib.Path(artifact["path"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == artifact["sha256"]
assert len(old_manifest["artifacts"]) == 31
print(json.dumps({
    "sourceHead": source, "sourceTree": restored["tree"], "restoredExecutionSeal": restored,
    "attempts": summaries, "bridges": bridges,
    "greenMinusOwnedOverlayEqualsFrozenSourceBytes": True,
    "previousManifestAnd31ArtifactsUnchanged": True,
    "scope": "R1 artifact/source attribution, not new application execution or Windows proof",
}, indent=2))
