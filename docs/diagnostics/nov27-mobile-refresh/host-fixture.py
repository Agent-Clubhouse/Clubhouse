"""Export two synthetic reconnect exchanges from release-pinned desktop contract recordings."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

RELEASES = {
    "beta7": "dc8e82236eb2ae8dadb6bd309297d0c157caaba4",
    "beta8": "30fd3ab0fdca6dbe75aed0b91e4c9878eded9b71",
}


def export(commit):
    source_hashes = {}

    def fixture(name):
        path = f"test/fixtures/annex-mobile/{name}.json"
        raw = subprocess.check_output(["git", "show", f"{commit}:{path}"])
        source_hashes[path] = hashlib.sha256(raw).hexdigest()
        return json.loads(raw)

    catalog = fixture("rest-catalog")
    projects = catalog["projects"]["response"]["body"]
    assert [project["id"] for project in projects] == ["proj_app", "proj_docs"]
    for index in range(3, 15):
        name = f"fixture_{index:02d}"
        projects.append({"id": name, "name": name, "path": f"/work/{name}"})

    role = fixture("snapshot-dispatcher")
    group = fixture("dispatcher-group-chat")["dispatcher"]
    history = group["history"]
    body = history["response"]["body"]
    selected = role["value"]["agent"]["id"]
    assert selected == body["agentId"] == "durable_dispatcher"
    assert any(event["type"] == "agent_message" and event["data"]["text"] == "On it." for event in body["events"])

    frame = fixture("snapshot")["frame"]
    payload = frame["payload"]
    payload["dispatcher"] = role["value"]
    payload["projects"] = projects
    routes = {}
    for project in projects:
        key = project["id"]
        rows = catalog["agents"]["response"]["body"] if key == "proj_app" else []
        payload["agents"][key] = rows
        routes[f"/api/v1/projects/{key}/agents"] = {"status": 200, "body": rows}

    state = fixture("agent-state")
    agents = state["response"]["body"]["agents"]
    agents[:] = [a for a in agents if a["agentId"] != selected] + [role["agentStateRow"]]
    # The recorded group conversation is sleeping, with retained readable history.
    # Replay these frames as a distinct delivery case, or deduplicate against the page.
    frames = group["frames"]
    payload["lastSeq"] = frames[0]["seq"] - 1
    assert [f["seq"] for f in frames] == list(range(payload["lastSeq"] + 1, payload["lastSeq"] + 1 + len(frames)))
    assert all(f["payload"]["agentId"] == selected for f in frames)
    assert all(f["payload"]["event"]["sessionId"] == body["sessionId"] for f in frames)
    capabilities = fixture("capabilities")
    cap_body = capabilities["response"]["body"]
    # The generic capability recording was made with Dispatcher disabled.
    # Use the role from the selected scenario across both surfaces.
    cap_role = cap_body["dispatcher"]
    for field in ["flagOn", "enabled", "projectId", "requestsUnderWay"]:
        cap_role[field] = role["value"][field]
    assert cap_role["enabled"] and cap_role["projectId"] == role["agentStateRow"]["projectId"]
    assert cap_body["epoch"] == state["response"]["body"]["epoch"] == body["epoch"]
    assert all(f["payload"]["event"]["agentId"] == selected for f in frames)
    for entry in [capabilities, fixture("network-list")["member"], catalog["projects"], state, history]:
        assert entry["request"]["method"] == "GET" and entry["response"]["status"] == 200
        routes[entry["request"]["path"]] = entry["response"]
    assert len(routes) == 19
    return {"version": 1, "desktopCommit": commit, "inputSHA256": source_hashes,
            "selectedAgent": selected, "snapshot": frame, "routes": routes,
            "chatFrames": frames, "expectedVisibleReply": "On it."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", choices=list(RELEASES))
    args = parser.parse_args()
    print(json.dumps(export(RELEASES[args.release]), sort_keys=True, indent=2))
