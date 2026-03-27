# Plugin SDK Version Lifecycle

This document defines the versioning contract between the Clubhouse host app and plugin developers. It covers version statuses, stability guarantees, the patch process, and guidance for both contributors and plugin authors.

---

## 1. Version Lifecycle

Every SDK version moves through four statuses:

| Status | Hash Locked | Meaning |
|--------|-------------|---------|
| **wip** | No | Under active development. API surface may change without notice. |
| **stable** | Yes | Released and frozen. CI-enforced integrity hash prevents unintentional changes. |
| **deprecated** | Yes | Still frozen and functional, but scheduled for removal. Plugins should migrate. |
| **removed** | N/A | SDK files deleted. Plugins targeting this version will fail validation. |

### Progression

```
wip  -->  stable  -->  deprecated  -->  removed
```

- A version enters **wip** when initial types are added to `plugin-types.ts` and `SUPPORTED_PLUGIN_API_VERSIONS`.
- It becomes **stable** once the API surface is finalized, reviewed, and hash-locked.
- It moves to **deprecated** when a newer version is ready and migration is recommended. A removal target release is announced (e.g. "will be removed in v0.39").
- It is **removed** when the target release ships. The version is dropped from `SUPPORTED_PLUGIN_API_VERSIONS` and its SDK files are deleted.

### Current Version States

| Version | Status | Notes |
|---------|--------|-------|
| v0.5 | deprecated | Removal target: v0.39 |
| v0.6 | deprecated | Removal target: v0.39 |
| v0.7 | stable | Current baseline for all plugins |
| v0.8 | stable | Canvas widgets, annex, window API |
| v0.9 | wip | Companion agents, MCP tool contribution |

---

## 2. Stability Guarantees

### For `stable` versions

**Your plugin will not break.** The API surface is hash-locked and CI-enforced. We guarantee:

- Method signatures will not change
- Types will not be removed or renamed
- Behavior will not be altered in backwards-incompatible ways
- New optional fields may be added (additive changes only)

If you build a plugin against a stable SDK version, it will continue to work until that version is deprecated and eventually removed — with advance notice.

### For `wip` versions

**No guarantees.** The API is subject to change without notice. Build against a wip version if you want early access to new capabilities, but expect:

- Methods may be added, renamed, or removed
- Type shapes may change
- Features may be gated behind experimental flags
- The version may not ship as designed

### For `deprecated` versions

**Still works, still frozen, but migrate soon.** A deprecated version:

- Retains all stability guarantees of a stable version
- Continues to pass validation and load plugins
- Shows deprecation warnings in the UI and logs
- Has a published removal target release

When you see a deprecation warning, check the migration guide and update your plugin to a newer API version before the removal date.

---

## 3. How Patches Work on Stable Versions

Occasionally, a security fix or critical bug fix requires modifying a stable API. This is the explicit process:

1. **Make the change** to the SDK types or implementation
2. **CI fails** — the integrity hash check detects the modification
3. **Run the hash update script**: `node scripts/compute-sdk-hash.mjs update <version>`
4. **Document the change** in the version's `PATCHES.md` file with:
   - Date
   - Reason (security, bug fix)
   - What changed
   - Backwards-compatibility analysis
5. **Open a PR** — reviewers will see the hash change and review the justification
6. **Patches must be backwards-compatible** — existing plugins must not break

Patches to stable versions are rare and require explicit justification. Adding a new optional field is fine; changing an existing method signature is not.

---

## 4. For Contributors

### Before modifying SDK files

1. Check `versions.json` in the Workshop repo for the version's status
2. If the version is `stable` or `deprecated`, **do not modify** without a patch justification
3. If the version is `wip`, modify freely

### If CI fails with an integrity hash mismatch

This means you changed a file that belongs to a hash-locked version. Options:

- **Unintentional**: revert your change to the locked files
- **Intentional (patch)**: follow the patch process in Section 3
- **Wrong version**: make your change in the `wip` version instead

### How to propose changes to a stable API

You can't modify a stable API without a patch justification. If you need new capabilities:

1. Target the current `wip` version instead
2. If the change is a critical fix for a stable version, open an issue describing the need and follow the patch process

---

## 5. For Plugin Developers

### Which versions are safe to build against

Build against **stable** versions for production plugins. These versions are frozen and will not change under you.

Check the current version states in `versions.json` or this document. As of v0.38:
- **v0.7** and **v0.8** are stable and recommended
- **v0.9** is wip — use for early access only

### How to know when a version is being deprecated

- The manifest validator emits warnings when loading plugins on deprecated versions
- The plugin marketplace and settings UI show a yellow "Deprecated API" badge
- The `DEPRECATED_PLUGIN_API_VERSIONS` map in the Clubhouse source lists deprecated versions and their removal targets
- Release notes announce deprecations

### Migration between versions

Each major version adds new capabilities while maintaining backward compatibility with features from previous versions. Key additions by version:

| Version | Key Additions |
|---------|--------------|
| v0.5 | Permission system, help contributions |
| v0.6 | Command keyboard bindings, defaultBinding |
| v0.7 | Plugin themes, global dialogs, agent config, file watching, pack kind |
| v0.8 | Canvas widgets, annex, window API, tab/rail titles, project-scoped projects API |
| v0.9 | Companion agents, MCP tool contribution, workspace plugin kind |

To migrate, update your `manifest.json`:
1. Change `engine.api` to the target version number
2. Update SDK import paths (e.g. `sdk/v0.7` to `sdk/v0.8`)
3. Review the version's changelog for any removed APIs (e.g. `HubAPI.refresh()` was removed in v0.7)
4. Rebuild and run validation
