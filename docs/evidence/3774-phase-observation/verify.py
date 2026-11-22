import hashlib
import json
import math
import pathlib
import sys
import xml.etree.ElementTree as ET


key = sys.argv[1]
root = pathlib.Path("docs/evidence/3774-phase-observation/attempts")
prefix = "CLUBHOUSE_MANAGED_PHASE_V1 "
raw = (root / f"{key}-original.txt").read_text()
receipt = json.loads((root / f"{key}-receipt.json").read_text())
tree = ET.parse(root / f"{key}.xml")
packets = []
for line in raw.splitlines():
    if line.startswith(prefix):
        packets.append(json.loads(line[len(prefix):]))
raw_transitions = 0
raw_bound_observed = False
for packet in packets:
    if packet.get("event") in ("begin", "end"):
        raw_transitions += 1
        assert raw_transitions <= 32, "Raw transition emission exceeded its per-record bound"
    elif "transitions" in packet or packet.get("observerUnavailable"):
        if packet.get("droppedTransitions") == 48 and raw_transitions:
            assert raw_transitions == 32
            raw_bound_observed = True
        raw_transitions = 0
phases = {
    "beforeEach", "seed.copy", "builtins.ensure", "body", "git.init", "git.add",
    "git.async", "delivery", "resolve", "grant.cleanup", "proof.await",
}


def finite(value):
    assert isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def snapshot(value):
    assert set(value) == {"event", "offsetMs", "aborted", "active"}
    assert value["event"] in ("abort", "final") and isinstance(value["aborted"], bool)
    finite(value["offsetMs"])
    assert len(value["active"]) <= 32
    for entry in value["active"]:
        assert set(entry) == {"beginSeq", "phase", "startMs", "elapsedMs"}
        assert entry["phase"] in phases
        for field in ("beginSeq", "startMs", "elapsedMs"):
            finite(entry[field])


def frame(value):
    if set(value) == {"version", "observerUnavailable"}:
        assert value == {"version": 1, "observerUnavailable": True}
        assert value in packets
        return
    assert set(value) == {
        "version", "platform", "node", "transitions", "abort", "final", "overflow",
        "droppedTransitions", "observerFailures", "observerUnavailable",
    }
    assert value["version"] == 1 and len(value["transitions"]) <= 32
    assert isinstance(value["overflow"], bool) and isinstance(value["observerUnavailable"], bool)
    for field in ("droppedTransitions", "observerFailures"):
        finite(value[field])
    for entry in value["transitions"]:
        assert set(entry) == ({"seq", "event", "phase", "offsetMs", "threw"}
                              if entry["event"] == "end" else {"seq", "event", "phase", "offsetMs"})
        assert entry["event"] in ("begin", "end") and entry["phase"] in phases
        finite(entry["seq"])
        finite(entry["offsetMs"])
        if entry["event"] == "end":
            assert isinstance(entry["threw"], bool)
    if value["abort"] is not None:
        snapshot(value["abort"])
    snapshot(value["final"])
    assert len(json.dumps(value).encode()) < 16_384
    assert value in packets, "JUnit final packet has no identical actual raw observation"


cases = [case for case in tree.iter("testcase") if case.find("skipped") is None]
failures = [case for case in cases if case.find("failure") is not None]
summary = []
all_frames = []
for case in cases:
    values = [json.loads(line[len(prefix):])
              for line in (case.findtext("system-err") or "").splitlines() if line.startswith(prefix)]
    for value in values:
        frame(value)
        all_frames.append(value)
    summary.append({"name": case.attrib["name"], "frames": values})

assert receipt["inputsUnchanged"], "Changed execution inputs"
assert hashlib.sha256((root / f"{key}-original.txt").read_bytes()).hexdigest() == receipt["logSha256"]
if "controls" in key or "mutant" in key:
    assert len(cases) == 8 and len(failures) == 2
    assert all(item["frames"] for item in summary), "Missing actual JUnit final diagnostic packet"
    assert raw_bound_observed, "No measured 32-line raw emission bound"
    setup = next(case for case in cases if case.attrib["name"].endswith("phase proof setup failure"))
    deadline = next(case for case in cases if case.attrib["name"].endswith("phase proof deadline abort"))
    assert setup.find("failure").attrib["message"] == "proof primary setup failure"
    assert "timed out in 5000ms" in deadline.find("failure").attrib["message"]
    setup_frame = next(item for item in summary if item["name"] == setup.attrib["name"])["frames"][0]
    assert any(entry["phase"] == "beforeEach" and entry.get("threw")
               for entry in setup_frame["transitions"])
    assert not any(entry["phase"] == "body" for entry in setup_frame["transitions"])
    timeout = next(item for item in summary if item["name"] == deadline.attrib["name"])["frames"][0]
    assert timeout["abort"]["aborted"]
    pending = next(entry for entry in timeout["abort"]["active"] if entry["phase"] == "proof.await")
    assert pending["elapsedMs"] >= 4990
    assert timeout["final"]["active"] == [] and timeout["final"]["aborted"]
    assert any(value.get("droppedTransitions") == 48 and len(value["transitions"]) == 32
               for value in all_frames)
    assert any(value == {"version": 1, "observerUnavailable": True} for value in all_frames)
    assert sum(value.get("observerUnavailable", False) for value in all_frames) >= 4
else:
    assert len(cases) == 68 and not failures and receipt["exit"] == 0
    assert len(all_frames) == 1
    assert not all_frames[0]["observerUnavailable"] and not all_frames[0]["final"]["active"]
    assert len(all_frames[0]["transitions"]) == 20

print(json.dumps({
    "key": key, "cases": len(cases), "expectedPrimaryFailures": len(failures),
    "actualJUnitPackets": len(all_frames), "rawPacketEquality": True,
    "staticPayloadAndFiniteBounds": True, "node": receipt["before"]["runtime"]["node"],
    "platform": receipt["before"]["runtime"]["platform"],
    "head": receipt["before"]["head"], "trackedDiffSha256": receipt["before"]["trackedDiffSha256"],
}, indent=2))
