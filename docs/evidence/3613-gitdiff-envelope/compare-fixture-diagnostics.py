import collections
import difflib
import hashlib
import json
import pathlib
import re
import subprocess
import sys


root = pathlib.Path.cwd()
attempts = root / "docs/evidence/3613-gitdiff-envelope/attempts"
server = "src/main/services/annex-server.test.ts"
base = "63f140b2a0ba00e686fb727a931d6b340fc3ee7e"
candidate_key = sys.argv[1] if len(sys.argv) > 1 else "05-corrected-target-types-lint"
output_name = sys.argv[2] if len(sys.argv) > 2 else "06-full-fixture-diagnostic-comparison.json"
candidate = json.loads((attempts / f"{candidate_key}-receipt.json").read_text())["before"]["head"]
old = subprocess.check_output(["git", "show", f"{base}:{server}"])
new = subprocess.check_output(["git", "show", f"{candidate}:{server}"])
opcodes = difflib.SequenceMatcher(None, old.splitlines(), new.splitlines(), autojunk=False).get_opcodes()
assert all(tag in ("equal", "insert") for tag, *_ in opcodes), "Only the two owned insertions may differ."
line_map = {
    new_start + i + 1: old_start + i + 1
    for tag, old_start, old_end, new_start, _ in opcodes if tag == "equal"
    for i in range(old_end - old_start)
}


def load(key):
    receipt = json.loads((attempts / f"{key}-receipt.json").read_text())
    raw = (attempts / f"{key}-original.txt").read_bytes()
    assert receipt["inputsUnchanged"] and receipt["exit"] == 2
    assert hashlib.sha256(raw).hexdigest() == receipt["logSha256"]
    text = raw.decode().split("FIXTURE_TYPES_BEGIN\n", 1)[1].split("\nFIXTURE_TYPES_END rc=2", 1)[0]
    pattern = re.compile(r"^(.+)\((\d+),(\d+)\): error (TS\d+): ", re.MULTILINE)
    matches = list(pattern.finditer(text))
    records = []
    for i, match in enumerate(matches):
        message = text[match.end():matches[i + 1].start() if i + 1 < len(matches) else len(text)].rstrip()
        records.append((match[1], int(match[2]), int(match[3]), match[4], message))
    return receipt, records


baseline_receipt, baseline = load("04-full-fixture-baseline")
candidate_receipt, current = load(candidate_key)
before = baseline_receipt["before"]
after = candidate_receipt["before"]
subprocess.run(["git", "merge-base", "--is-ancestor", before["head"], after["head"]], check=True)
head_delta = subprocess.check_output(["git", "diff", "--name-only", before["head"], after["head"]]).decode().splitlines()
control_test = "src/main/services/annex-control.test.ts"
assert set(head_delta) <= {control_test}, "No production, config or other graph change may enter this diagnostic comparison."
assert before["gateSha256"] == after["gateSha256"]
assert before["runtime"] == after["runtime"] and before["installed"] == after["installed"]
left = {item["path"]: item["sha256"] for item in before["inputs"]}
right = {item["path"]: item["sha256"] for item in after["inputs"]}
assert left.keys() == right.keys()
changed_inputs = [path for path in left if left[path] != right[path]]
assert server in changed_inputs and set(changed_inputs) <= {server, control_test}
assert left[server] == hashlib.sha256(old).hexdigest()
assert right[server] == hashlib.sha256(new).hexdigest()
assert all(path == server and line in line_map for path, line, *_ in current), "Changed-hunk or other-file diagnostics remain."
mapped = [(path, line_map[line], column, code, message) for path, line, column, code, message in current]
assert collections.Counter(baseline) == collections.Counter(mapped), "Content, column, multiplicity or legitimate source-line mapping differs."
normalized = json.dumps(sorted(mapped), ensure_ascii=True, separators=(",", ":")).encode()
result = {
    "baselineCommit": base, "candidateCommit": after["head"],
    "compilerGraph": "fixture-tsconfig.json: all three actual changed tests; settings unchanged",
    "baselineCount": len(baseline), "candidateCount": len(current),
    "changedHunkDiagnostics": 0, "mappedFullDiagnosticContentEqual": True,
    "normalizedDiagnosticSha256": hashlib.sha256(normalized).hexdigest(),
    "baselineServerSha256": left[server], "candidateServerSha256": right[server],
    "changedInputs": changed_inputs, "selectedInputs": len(left),
    "committedHeadDelta": head_delta,
    "limitation": "Both full strict fixture compilers FAIL. Zero new diagnostics is not a fixture type-check PASS or acceptance.",
    "insertedRanges": [
        {"baselineAfterLine": old_start, "candidateFirstLine": new_start + 1, "candidateLastLine": new_end}
        for tag, old_start, _, new_start, new_end in opcodes if tag == "insert"
    ],
    "diagnostics": [
        {"file": path, "candidateLine": line, "baselineLine": line_map[line],
         "column": column, "code": code, "message": message}
        for path, line, column, code, message in current
    ],
}
destination = attempts / output_name
if destination.exists():
    raise FileExistsError(destination)
destination.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key != "diagnostics"}, indent=2))
