#3733 finite section2 sleeping remote inline helpers — unfinished bounded source
Base: d90cd8d504b7085aed04d4728a0b2cfea72468e6
Branch: Nov20AutoCI/3733-sleeping-inline-helpers

Only SleepingAgent and the existing RemoteAgentDetailsView read owner change.
A normal remote durable with matching agent/project host namespaces mounts one
existing authorized Details read owner. While Details is hidden and the pane
is not compact, only its existing RemoteHelpersCard is portaled into the inline
under-composer slot. Opening/closing Details changes presentation, not the read
owner or key; no duplicate initial request/subscription is added. Existing
selected host/agent/status/snapshot/transport-generation/error/authority fences
and the same paired/pinned server GET apply. There is no local config/helper
fallback or new route, grant, mutation, lifecycle or approval control.

Inline mode does not hydrate provider/transcript evidence, including a sleeping
runtime retaining a session ID. Helper pages remain the existing selected helper
reads. The read owner disables itself when neither Details nor the noncompact
inline surface is visible; re-enable changes generation and withholds retained
facts until refreshed. Canonical Dispatcher/Quick helper surfaces are excluded.
Mismatched/missing host namespace displays a precise limitation without reading.
Pending starts auto-open the existing read-only helper accordion. Known empty
non-orchestrating data stays absent; unavailable/unknown evidence remains explicit.
No full-Details card data other than helpers/policy is rendered inline.

Prepared fixtures cover actual SleepingAgent with real remote Details read
owner: helpers/pending read-only rows, no local APIs or transcript hydration,
one initial read across Details toggle, offline/reconnect/refusal, wrong-host
identity and delayed prior-parent response. Exact proof is pending coordinated
lane; this source checkpoint is not accepted or claimed tested. Other hold
boundaries and independent review remain required. No PR/merge/default push.
