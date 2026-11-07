# Catalog skill bundle editor boundary

This component and typed bridge edit existing installation-catalog skill bundles.
They reuse `SkillAssetPayload`, catalog validation, impact planning and immutable
revision saving. They introduce no filesystem skill model. This host adds
App Settings > Skill library with an explicit registered-project scope. Builder
and native discovery remain separate. Host and visual/integration acceptance
remain outstanding under #2819 and #2740.

`SkillBundleEditor` is controlled by a complete `SkillAssetPayload`. Its folder
list is derived only from `files`; selecting a member does not read a directory.
Text uses the existing Settings Monaco component. Binary members are edited as
explicit base64, without rendering images, SVG, HTML or other content. Executable
metadata is a stored boolean, never an execution action. Supporting members can
be added, renamed and removed. `SKILL.md` stays present. Paths and relative links
remain literal; renaming a member does not rewrite references in other files.
Every edit copies the complete payload and changes only the selected member.
The catalog canonicalizes ordering and equivalent utf8/false metadata as before.
Saved binary bytes and every unedited member survive partial UI edits.

The model covers regular files. It does not represent symlinks, empty directories,
UID/GID or full filesystem mode bits. This editor makes no ownership change and
does not execute scripts, assign skills, enable them, import native skills or
claim anything was loaded by a runtime. Its scope notice remains on screen.

## Typed local-user bridge

`window.clubhouse.catalogSkillBundles` exposes `list`, `read`, `preview`, `save`.
Requests carry a registered `projectId`, an optional current `agentId`, and catalog
asset IDs. Renderer-supplied absolute paths, capability objects, delivery policy,
assignment manifests and arbitrary commit bytes are absent from the API. IPC
validators reject extra fields. Main resolves current registration and agent
config; Dispatcher contexts, helpers, disposed and partial-creation agents are refused. The
service independently requires UI origin without an acting agent. No wire,
mobile, MCP or CLI entry is added.

Only library assets and assets owned by the selected registered project/agent
are visible. Owner and source are shown explicitly. Built-ins remain read-only.
There is no create/delete-asset operation or ownership conversion.

Preview requires the saved catalog revision and a complete candidate payload.
The catalog validates all members and computes its normal `AssetImpact`.
**Any agent, template or subagent consumer blocks saving in this first boundary.**
The preview shows consumer counts and refusal. It cannot offer meaningful shared
impact confirmation until the host can supply complete consumer workspace and
foreign-destination context; an omitted context is not evidence of safety.
Independent copies are shown but do not follow this edit.

An allowed preview holds exact candidate bytes, context, expected revision and
impact fingerprint behind a random token. At most four bundles are retained,
for two minutes. Save accepts that token, not a replacement payload. Tokens are
single-use, expire and cannot be reused for another target or revision. Save
rechecks current ownership, consumer impact and revision through the catalog.
Consumers appearing after preview are refused by the catalog's serialized impact
and revision checks. There is no base/project adoption default.

Context checks use the existing registry pending-write/generation evidence and
agent config generation. Agent-target writes reserve the existing transition
gate. The per-request catalog instance uses the existing rename hook to check
these guards immediately before synchronous catalog rename, after asynchronous
staging I/O. The catalog's existing per-directory serialization and retry bounds
are retained. This prevents an ordinary pending app registry write completing
between check and commit. It is not a native filesystem sandbox or protection
against a malicious same-user rewrite of private app storage. Catalog operations
and their normal ID-only audit retain existing behavior. Payloads and raw errors
are never logged by this boundary.

## Host integration contract and remaining limits

`CatalogSkillBundleEditor` accepts `{context, assetId, bridge?, onDirtyChange?}`.
The Settings host supplies the explicit registered-project context and catalog
selection. It confirms draft discard on asset/project/list replacement and keeps
the page mounted, hidden and inert during ordinary navigation. This is memory-only
preservation, not durable draft recovery. Returning/focus revalidates catalog state;
main still checks revision/context at mutation. Optional busy/saved callbacks bind
to editor identity and operation number. Do not replace the current on-disk Skills page or the held Builder
surface with this editor. Native skills must eventually be visible without
requiring import, but no confined directory enumeration exists for that adapter
yet. #2830's confinement hold is unchanged.

The component clears preview on any payload edit, reload or target change and
ignores late target/operation replies. Synchronous callback guards reject retained
Monaco changes and duplicate review/save callbacks while an operation is pending. It shows fixed visible failures, retains
unsaved drafts after failed saves and offers explicit reload/discard for stale
revisions. It does not claim rollback of a committed catalog revision.

Automated synthetic fixtures cover text/binary preservation, executable metadata,
relative paths and collisions, supporting-file CRUD, built-in/source/owner display,
stale writes, failure and target changes, preview token binding, blocked shared
impact, typed IPC/preload and registration. A catalog-only write test preserves
synthetic instructions, identity, sessions, wires and worktree files. No app,
provider or script is launched. Human visual review and host integration remain
unverified; component tests are not screenshots or runtime-load evidence.
