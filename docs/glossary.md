# Glossary

Canonical names for cross-computer Dispatcher behavior. The broader product vocabulary is tracked in #2758.

| Canonical term | Meaning | Code name | Avoid | Owner |
|---|---|---|---|---|
| Federated Dispatchers | Dispatchers on computer members of one Annex Network, coordinating while each keeps local grants and memory. A person can choose one lead for the conversation. | `dispatcher-federation*` | shared memory, automatically elected leader | Dispatcher federation (#2834) |
| Controller link | An automatic two-way coordination connection between members' hidden Dispatcher controllers, with fixed tools and pairing-bound authorization. | `dispatcher-federation`, `ConnectionDirection` | a link between visible chats, a phone connection | Dispatcher federation (#3345) |
| Remote request | A controller-to-controller work subtask admitted durably and triaged by the receiving controller. Delivery and explicit work outcome are separate. It is distinct from news and from a Handoff agreement. | `FederatedRequest`, `hand_off_request` | completed because delivered, remote approval, Handoff agreement | Dispatcher federation (#3346, #3347) |
