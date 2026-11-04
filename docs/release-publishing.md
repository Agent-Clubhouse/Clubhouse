# Publishing a release

`.github/workflows/release.yml` builds a release, and `scripts/ci/release-publish.sh` publishes it. This page covers the publish order, what a failure leaves for users, how to recover and how to roll back.

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

## If a step fails

The recovery is GitHub's **Re-run failed jobs** once the cause is fixed. No step is a reason to cut a new version, with the two exceptions below.

These are the effects for a stable tag. A beta tag is the same with the preview feed and slots, and stable users are never affected.

| Failed at | What users see | Notes |
|---|---|---|
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
6. Fix forward with a patch release.

**This doesn't move anyone back.** Clients on the bad version won't downgrade, and neither will Squirrel. macOS and Linux clients that already downloaded the bad version keep it pending and can still install it at quit.

## How this is tested

`scripts/ci/release-publish.test.ts` runs the script against fake `az` and `gh` binaries, with a directory standing in for the container. It proves the order of writes, what a failure at each point leaves behind, that a re-run finishes, and what the script refuses to do. It doesn't prove how the real CLIs behave.

A beta tag exercises the shared steps on real services. Re-running its Publish job afterwards checks that a repeat is safe, and only `releaseDate` changes in the preview manifest.

Only a stable tag exercises these:
- The stable path against real storage: `history.json`, `squirrel/stable`, the `latest/` slot and both `latest.json` writes
- The GitHub release being marked Latest
- A Windows client moving from a beta to the same-base stable build through `Update.exe`
