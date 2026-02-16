# Extensibility Principles

## Principle 1: Opinions Are Opt-In

The way one person uses AI agents is not the way another will. Highly opinionated workflows are valuable — but only to the people who share those opinions. Baking them into the core turns a preference into an imposition.

- **The core host is unopinionated.** It provides capabilities, not workflows. It does not assume how you organize agents, what models you prefer, how you review output, or what a "good" session looks like.
- **Opinions belong in plugins.** A plugin can be as opinionated as it wants — that's the point. It can enforce a strict review flow, auto-organize agents by branch, require approval gates, or do nothing at all. Users install the opinions they agree with.
- **No default workflow is "correct."** If a feature assumes a specific way of working, it should be a plugin that users enable, not a core behavior that users endure. The test: would a reasonable user want to turn this off? If yes, it doesn't belong in core.
- **Diversity of use is a strength.** The goal is a platform where ten people can use Clubhouse in ten different ways and none of them are fighting the tool. The extensibility model exists to make this possible.

### The line between capability and opinion

A capability is: "you can run multiple agents concurrently."
An opinion is: "agents should be organized by git branch."

A capability is: "plugins can react to agent status changes."
An opinion is: "idle agents should be automatically paused after 5 minutes."

Capabilities go in the host. Opinions go in plugins. When in doubt, ask: does this help everyone, or does it help people who work like me? If the latter, it's a plugin.

## Principle 2: Change at the Least Obtrusive Layer

Make changes at the outermost layer that can support them. Each layer inward affects more users and is harder to reverse.

```
Community Plugin  →  Core Plugin  →  Plugin API  →  Core Feature  →  App Host
   (least)                                                           (most)
```

- A **community plugin** affects only users who install it. Ship here by default.
- A **core plugin** ships with Clubhouse but is optional. It affects users who enable it.
- A **plugin API change** affects every plugin author. Additive changes extend the current version; breaking changes require a new major version.
- A **core feature** is always on for everyone. It cannot be opted out of.
- An **app host change** alters the foundation that everything else runs on. It affects every user, every plugin, every workflow.

The further inward you go, the higher the burden of proof that the change belongs there.

### Why this matters

Clubhouse supports many diverse work patterns. A change that improves one workflow must not break another. Outer layers are isolated — a community plugin can be weird, opinionated, or experimental without risk to anyone else. Inner layers are shared — a host change that assumes a particular workflow forces that assumption on everyone.

Defaulting to the outermost viable layer keeps the blast radius small, keeps options open, and lets the ecosystem grow without centralizing every decision.

## Principle 3: Explicit Support, No Silent Regression

Be explicit about which API versions we support. Fully support the ones we claim. Never quietly break them.

- **Declare support explicitly.** The set of supported API versions is a source-of-truth list in code, not something implied by which tests happen to pass. If a version is in the list, we support it. If it's not, we don't.
- **Supported means fully working.** Every method, type, and behavior documented for a supported version must work correctly. No stubs, no silent no-ops, no "mostly works." If we say we support v1, a v1 plugin runs exactly as v1 promises.
- **Tests prove the commitment.** Each supported version has tests covering its full surface. A failing test for a supported version is a release blocker. If you need to change an existing test to make your code work, you are making a breaking change — rev the version instead.
- **Reject what we don't support.** A plugin targeting an unsupported version is rejected at load time with a clear message. We don't load it and hope for the best.

### Corollary: Know when to let go

Supporting old versions has a real cost. When that cost begins to constrain the evolution of the platform — blocking new capabilities, requiring complex compatibility shims, or creating maintenance burden that slows everything else down — it is time to drop the old version.

Dropping a version is not a failure. Carrying a version we can't properly maintain is. A clean, announced drop is better than slow erosion where the version technically loads but subtly breaks.

### Relationship to Principle 2

This principle serves Principle 2. The layer model only works if plugin authors can trust the API layer beneath them. If we silently regress a supported version, plugins break through no fault of their own — and authors are forced to work around host instability instead of building on a stable platform. Explicit support and no-regression are what make the outer layers viable.
