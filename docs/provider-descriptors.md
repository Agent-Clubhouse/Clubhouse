# Provider descriptors and the effective feature contract

Issues: #3787 (descriptor), #3803 (Auto policy). Epic #3785.

Clubhouse keeps each provider's own integration: the Claude Agent SDK and
stream-json drivers, the Codex app-server, the Copilot SDK, and each CLI in a
terminal. They are not moved onto one protocol. What is shared is the
app-facing contract. A surface asks what a provider offers and gets an answer
that says where it came from.

## Layers

| Layer | Where | Decides |
|---|---|---|
| Static policy | `src/shared/providers/descriptors.ts` | Names, glyph, badge, install link, telemetry code, Access levels per runtime, helper presets, Auto policy and quota kind, capacity tracking, state folder, declared features |
| Negotiated session | each driver's `ChatCapabilities` in `session_started` | What a running chat session offers |
| Effective feature | `resolveEffectiveFeature` in `src/shared/providers/features.ts` | What a surface may offer, with a source and reason |

Resolution order:

1. A declaration with `policy: 'forbidden'` is a Clubhouse decision. It is unsupported whatever a session reports.
2. With a live session, a feature that maps directly onto a capability field (steering, cancellation, images, questions, session resume, usage, model switch, effort switch) follows the session. Tools, MCP, managed instructions, skills, permissions and session history are never inferred from those fields.
3. A `conditional` declaration lists conditions (platform, version, auth, setting). Each needs evidence from the caller. One unmet condition makes the feature unsupported with that condition's description, and a condition with no evidence leaves it `conditional`. Neither case is treated as met.
4. Otherwise the declaration applies. A feature the provider doesn't declare is `unknown`. Clubhouse doesn't treat it as unsupported or as supported.

Only `supported` offers the feature.

## Existing providers

Chat features, as each driver publishes them. `provider-feature-mapping.test.ts` checks this table against the drivers' exports.

| Feature | Claude Code (Agent SDK, stream-json) | Codex (app-server) | Copilot (SDK) |
|---|---|---|---|
| Steering | supported | supported | supported |
| Cancellation | supported | supported | supported |
| Images | supported | supported | supported |
| Questions | supported | unsupported | supported |
| Session resume | supported | supported | supported |
| Usage | cost and tokens | tokens | tokens |
| Model switch | live | from the next message | live |
| Effort switch | live | from the next message | live |

Every provider declares session history for remote Details. Features not in the table are undeclared, so they resolve to `unknown`.

| Policy | Claude Code | Codex | Copilot |
|---|---|---|---|
| Access, chat | all five levels | all five levels | Plan, Ask first, Auto-accept edits, Full access |
| Access, terminal | all five levels | Ask first, Auto, Full access | Ask first, Full access |
| Helper presets | yes | yes | yes |
| Auto | candidate | candidate | candidate, allowed unless `copilotAuto` is off |
| Quota | reader | reader | unknown (ranked last) |
| Auto budget reserve | yes | yes | no |
| Handoff capacity | yes | yes | yes |

## Helper Auto policy (#3803)

- `candidate`: Auto may pick the provider. A provider allow setting can still turn it off.
- `opt_in`: Auto skips it unless the person turns its allow setting on.
- `excluded`: Auto never picks it. Asking for it by name still works.

Providers whose quota Clubhouse can read are ranked by how much remains. A
provider whose quota is unreadable right now ranks as `unmeasured`. A provider
declared `quota: 'unknown'` has no reader at all and ranks `last_resort`,
behind every other eligible tier. Today that is Copilot. Settings explains the
ranking: "Its quota is unknown."

## Adding a provider

Add a descriptor. Its telemetry code also needs a reviewed addition to
`PROVIDER_TELEMETRY_CODES`; until then the provider reports `other`. Some sets
are persisted or sent to peers: Auto budget reserves, handoff capacity keys and
helper presets. Changing one of them is a schema change and needs its own
review. Provider-specific behaviour stays in the provider and its driver.
