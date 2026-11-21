# #3749 current-main composition: fd80a1c58 (#3753 P7, #3754)

`3a23aec18597115238f98d0fbf99ae7bb8a9a172` merges `main` `fd80a1c58e3362b03440f7a315db8918cda15ee4` into the #3749 head `33cfd9cf02896ea7757b951279a2baa635261ee1`. These are sanitized copies of output.

- The merge is clean. The only file changed by both sides is `src/shared/types.ts`. #3749's `SatelliteConnection` receipt/generation fields and `snapshotTruncated` are separate interfaces from P7's `AnnexDirection` change (+2 lines at about 1344). Lockfile unchanged.
- `tsc.txt`: exit 0. `lint.txt` (scope: `lint-scope.txt`, changed from `fd80a1c58`): exit 0.
- `focused.txt`: `vitest run --no-cache --maxWorkers=3` with a fresh default-depth `TMPDIR` over 14 files. 14 files, 1683 passed, exit 0. Pre- and post-status clean.
  - The 14 files are every test file `main` changed since `daa7dab5e`: `annex-control`, `annex-devices`, `group-project-remote-create.sim` (the previously failing regression, now with #3754), `AnnexDeviceList` and `AnnexNetworkSettingsView`.
  - Plus #3749's `SatelliteConnection`/annex lifecycle consumers: `annex-client`, `annex-control-reconnect`, `annex-server`, `annexClientStore` ×2, `RemoteAgentDetailsView`, `RemoteDispatcherDetails`, `annex-network-membership` and `bridge-server`.
- **One passing run does not establish the sim's original trigger.** It stays unknown.
- `store-before.txt` and `store-after.txt`: the shared dependency store's modification times and `.cache` entry count are identical across the run. The isolated per-entry `node_modules` was used.
- Not run: a full suite. The Windows rename E2E (#3720 class) is not exercised locally.
