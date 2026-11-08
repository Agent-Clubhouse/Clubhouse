# Publishing a release

`.github/workflows/release.yml` builds a release, and `scripts/ci/release-publish.sh` publishes it. This page covers the publish order, what a failure leaves for users, how to recover and how to roll back, and how to publish chat's CLI kill switch without a release.

## Supported systems

macOS 13 or newer is required: Electron 44 dropped macOS 12, and Clubhouse is on Electron 45.

v0.41.0 has no OS check. A v0.41.0 client on macOS 12 can be replaced by a build that won't launch, because its updater removes the old app before installing the new one. This is an accepted risk, not a fixed one. Nothing in the updater or this pipeline prevents it, and macOS 12 isn't supported.

## Publish order

Everything a manifest points at goes live before the manifest does. Updaters act only on a manifest, so they can't be told about a version they can't fetch.

| Step | Writes |
|---|---|
| 0. Preflight | Nothing. Checks the Squirrel output and, for stable, `history.json` and the preview version |
| 1. Artifacts | `artifacts/*`, which never change once published |
| 2. Squirrel | The channel's `squirrel/<channel>/win32-*`, packages before `RELEASES`. A stable build also goes to `squirrel/preview` unless preview has moved past it |
| 3. Download slots | `latest/*` or `preview/*` |
| 4. GitHub release | Creates it, or re-uploads the assets on a re-run |
| 5. History and manifests | Stable: `history.json`, then `updates/latest.json`, then `updates/v2/latest.json`. Beta: the seed for a missing `v2/latest.json`, then `updates/preview.json`, then `updates/v2/preview.json` |

Windows preview-channel clients only read `squirrel/preview`, even when the manifest they picked is stable. That's why a stable build goes to both feeds. Clients built with a fix can read the stable feed directly, but released ones can't change.

Tags must be `vX.Y.Z` or `vX.Y.Z-beta.N`, and legacy `vX.Y.Zrc` tags still parse. Anything else fails at Verify Tag. Clients read `0.42.0-rc.1` as `0.42.0` stable and would never be offered the real `0.42.0`, so use `-beta.N` for a candidate.

Release notes come from the version bump PR's body (`scripts/ci/release-notes.mjs`), and `republish-notes.yml` corrects them after a release. When the `prepare-release` skill drafts that body, its commit scan starts from the previous stable tag, never a beta tag (step 4), since `v0.42.0-beta.14` sorts above `v0.42.0`. That holds for a beta promoted to stable as well as for a patch or minor bump.

## If a step fails

The recovery is GitHub's **Re-run failed jobs** once the cause is fixed. No step is a reason to cut a new version, with the exceptions below.

These are the effects for a stable tag. A beta tag is the same with the preview feed and slots, and stable users are never affected.

| Failed at | What users see | Notes |
|---|---|---|
| Generate update manifest | Nothing changes | Nothing was written. This step checks main's `release/chat-cli-denylist.json` with the tag's copy of the script. See below for a bad list, and for a re-run of an older tag |
| 0. Preflight | Nothing changes | Nothing was written |
| 1. Artifacts | Nothing changes | Nothing points at the uploaded files. A re-run skips identical files |
| 2. Squirrel | Nothing changes on macOS or Linux. Windows clients don't update until a manifest says to | A preview client with a beta restart pending may land on the stable build, which is fine |
| 3. Download slots | New website downloads may get the new version before updaters do, and architectures can differ for a while | |
| 4. GitHub release | Nothing changes for updaters | |
| 5. History or legacy manifest | Clients hide history entries newer than themselves. A failed legacy manifest affects only clients on v0.34 or older | |
| 5. `updates/v2/latest.json` | The old version stays live | This is the last write, and a single blob upload |

**When a re-run isn't enough, cut a new version:**
- An artifact already exists with different bytes. The run stops rather than replacing a published file.
- Build artifacts last 5 days. After that a re-run rebuilds them, the signed bytes differ, and the run stops for the same reason.
- A re-run of an older tag, when main's chat CLI list names a driver or provider that tag's script doesn't know. Generate update manifest fails before any write. Don't take the entry off the list to get past it: that release's manifest would then replace clients' lists without the entry.

**A list on main that fails validation stops Generate update manifest too.** Fix the file on main, then re-run. The step reads main again.

**Preflight also stops the run for these**, and they need fixing first:
- `updates/v2/history.json` can't be read, is missing, or isn't a non-empty array. Restore it. The run won't start a new history.
- `updates/v2/preview.json` can't be read.
- A Windows architecture has no Squirrel `RELEASES` or package. This applies to betas too.

## Rollback

**Before tagging stable**, save these public files to a dated folder:
- `updates/v2/latest.json` and `updates/latest.json`
- `updates/v2/history.json`
- `RELEASES` from `squirrel/stable/win32-x64`, `squirrel/stable/win32-arm64`, `squirrel/preview/win32-x64` and `squirrel/preview/win32-arm64`

**If a stable release is bad:**
1. Upload the saved `updates/v2/latest.json` and `updates/latest.json`. Clients stop being offered it.
2. Upload the saved `RELEASES` files. Windows clients stop finding it.
3. Copy `artifacts/Clubhouse-<old>-*` back over the `latest/` slot.
4. Run `gh release edit v<old> --latest`, and mark the bad release as a prerelease.
5. Leave `history.json` alone. Clients hide versions newer than themselves.
6. If `release/chat-cli-denylist.json` on main isn't what the saved manifests carry, run the publish in [Chat's CLI kill switch](#chats-cli-kill-switch). A saved manifest brings back the list it was saved with, and that replaces the list on clients.
7. Fix forward with a patch release.

**This doesn't move anyone back.** Clients on the bad version won't downgrade, and neither will Squirrel. macOS and Linux clients that already downloaded the bad version keep it pending and can still install it at quit.

## Chat's CLI kill switch

`chatCliDenylist` in the update manifests lists CLI versions known to break chat. An agent on a matching CLI opens in the next mode down at its next start, and the person sees the reason. A person runs this per incident. Nothing runs it automatically.

### What it does and doesn't reach

- Clients pick the list up on their next update check, and agents move at their next start. It doesn't stop a running agent.
- Clients with chat off don't save the list. Clients with auto-update off get it only on a manual check.
- Clients on v0.34 or older read the legacy manifest paths and ignore the field. The publish still writes those paths so they stay identical to what a release writes.

### The list file

`release/chat-cli-denylist.json` on main is the source of truth. Every release reads it from main when it generates its manifest, and the publish workflow reads it from main when it writes. The workflow has no input for the list, so the two can't disagree, and the next release can't drop what was published.

Releases read main rather than the tag because a tag sits on its bump commit. A list merged after that commit, or a re-run days later, would otherwise publish an older list, and an array replaces what clients have saved.

| The file holds | A release | The publish workflow |
|---|---|---|
| `null` | Leaves the field out, which keeps every client's saved list | Refuses, there's nothing to publish |
| `[entry, ...]` | Writes the list, which replaces every client's saved list | Writes the list |
| `[]` | Writes `[]`, which empties every client's saved list | Refuses unless `clear_list` is on |

`null` is the state until the first entry. It isn't `[]` because `[]` is an instruction to clients, so a release shouldn't send it until someone means it. After the last entry is lifted the file stays `[]` and doesn't go back to `null`. A manifest without the field keeps a saved list, so a client that was offline for the clear would otherwise keep the block for good.

An entry names a `driver` or a `provider`, and has `versions`, a `range`, or both, and a `reason`:

```json
[
  { "provider": "claude-code", "versions": ["2.1.250"], "reason": "Hangs on start. Fixed in 2.1.251." },
  { "driver": "claude_agent_sdk", "range": { "from": "2.1.240", "to": "2.1.249" }, "reason": "The SDK handshake fails." }
]
```

- `provider` is `claude-code`, `codex-cli` or `copilot-cli`, and matches every driver of that CLI, so the agent opens in the CLI view.
- `driver` is one chat driver, such as `claude_agent_sdk`, and the agent moves to the CLI's next driver if it has one.
- `versions` are exact, and a `range` is inclusive with either end optional. Each is a plain `x.y.z[-prerelease]`. There are no wildcards.
- `reason` is required, and is shown to users after "Claude Code 2.1.250 is known to break chat:". 300 characters at most.

`scripts/ci/cli-denylist.mjs` fails on anything a client would drop or rewrite, where a client drops it silently. It also fails on what a client would accept and then get wrong, such as an unknown provider that never matches or a misspelled range field that widens the range. Validate's unit tests check the committed file, a dry run checks it, a publish checks it, and a release checks it again.

### Adding an entry

1. Open a PR that adds the entry to `release/chat-cli-denylist.json`. If the file holds `null`, replace it with an array. To check it locally:
   ```
   node scripts/ci/cli-denylist.mjs validate --list release/chat-cli-denylist.json
   ```
2. Dry run from the PR's branch, and read the log of the "Show changes" job. Each of the four manifests should say `status=updated`, with the diff you expect. A dry run writes nothing and uses no Azure login.
   ```
   gh workflow run publish-cli-denylist.yml --ref <branch>
   ```
3. Merge the PR once Validate is green. A PR that edits only this file runs no E2E or macOS build, and its unit job checks the file. Nothing reaches clients yet, except through a release that happens to start after this.
4. Publish from main. This writes at once: the `release` environment has no protection rules, so nobody approves it, and the dispatch is the last check. It re-reads the file from main at this point.
   ```
   gh workflow run publish-cli-denylist.yml --ref main -f dry_run=false
   ```
5. Check all four manifests:
   ```
   for b in updates/latest.json updates/v2/latest.json updates/preview.json updates/v2/preview.json; do
     curl -fsS "https://stclubhousereleases.blob.core.windows.net/releases/$b" | jq -c '{version, chatCliDenylist}'
   done
   ```

### Lifting an entry

Follow the same steps with the entry removed. Clients replace their list with the new one, and a blocked CLI goes back to chat at the agent's next start.

Removing the last entry leaves `[]`, and step 4 needs `-f clear_list=true`.

Don't set the file back to `null`, which leaves every client that saved the entry blocked. A `git revert` of the PR that added the first entry does exactly that. The Plan the run job in Validate fails on any change from an array to `null`, or one that deletes the file, and says to use `[]`.

### What a failed publish leaves

The workflow writes each channel's legacy manifest, then its v2 manifest, stable first: `updates/latest.json`, `updates/v2/latest.json`, `updates/preview.json`, `updates/v2/preview.json`. Every other byte of each file stays as it was, and `history.json` isn't touched.

| Failed at | What users see | Recovery |
|---|---|---|
| Checking the list | Nothing changes | Fix the file on main |
| Reading any manifest | Nothing changes, because all four are read before the first write | Restore the manifest, then re-run |
| An upload | Manifests before it have the list, and the rest don't. A stable-channel client may have it while a preview-channel client doesn't | Re-run failed jobs. Finished manifests report `status=unchanged` and aren't written again |
| A Release run is active | Nothing changes | Re-run once it finishes. A release that's running can overwrite a manifest after this run wrote it |
| Run from a branch or tag | Nothing changes | Merge, then run from main |

Each upload is pinned to the ETag it read, so if anything else writes that manifest in between, the upload fails rather than overwriting it. A re-run reads it again.

The `latest.json` or `preview.json` asset on a GitHub release keeps the list it was built with. No updater reads it.

### If the file on main and the live manifests differ

Merging without publishing leaves the manifests behind main until the next release or publish, which is safe, and a publish catches them up. Editing a manifest by hand does the opposite: the next release overwrites it with main's list, so put the change in the file.

## How this is tested

`scripts/ci/release-publish.test.ts` runs the script against fake `az` and `gh` binaries, with a directory standing in for the container. It proves the order of writes, what a failure at each point leaves behind, that a re-run finishes, and what the script refuses to do. It doesn't prove how the real CLIs behave.

The same file runs `scripts/ci/publish-cli-denylist.sh` and the real Generate update manifest step against those fakes, and `scripts/ci/cli-denylist.test.ts` runs the validator and the client's `sanitizeDenylist` over the same inputs. `src/main/services/agent-runtime/chat-spawn-denylist.test.ts` takes a manifest the publish path wrote through to a real chat start, with a fake CLI. The fakes can't prove how `az` handles `--if-match` for real, and the publish workflow hasn't run against real storage.

A beta tag exercises the shared steps on real services. Re-running its Publish job afterwards checks that a repeat is safe, and only `releaseDate` changes in the preview manifest, along with `chatCliDenylist` if main's list changed since.

Only a stable tag exercises these:
- The stable path against real storage: `history.json`, `squirrel/stable`, the `latest/` slot and both `latest.json` writes
- The GitHub release being marked Latest
- A Windows client moving from a beta to the same-base stable build through `Update.exe`
