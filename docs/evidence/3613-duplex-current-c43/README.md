# Current duplex capability and acceptance map

The accompanying `map.json` is a source-only inventory of main
`c43ffb37d20650c542e449a8a04a9fd84e65b655`, tree
`0193de3b749c243667983176c9807b9fe9749f8e`, for #3613. Its original SHA256 is
`1fb3e1ccc90bd2b1809e9b46cef202a2775c593713c151640ce95fd5be66fd85`.

Routes, reverse-control targets, directional readiness and the narrow desktop
controller GET consumers are landed. Ordinary desktop reverse request and stream
consumers remain incomplete. The current HTTP table has **82 entries**; this is
a static census, not 82 executed or accepted routes.

#3695, #3715 and #3738 are closed with fixes on this main. #3711 legacy outgoing
peer removal and #3714 over-budget whole-link retirement remain explicit defect
closures. Naming #3720 and full Details #3733 are separately owned and incomplete.

The next coherent milestone is current-main remaining-consumer request, read,
subscription and device integration with one forward route and reverse direct
blocked. It preserves captured direct-priority selection, no write fallback,
existing field/authority fences and one fully retired owned stream. Details
read/receipt hunks require the actual owner's concurrence. #3711 stays separate;
#3714 requires narrow independent security review.

The historical stack, P8 drafts #3721/#3736 and their CI are not current-main
acceptance. Current-app/P8, binary/effect/fault, complete process-tree confinement,
cleanup and independent security gates remain. The specific refused federation
review is not repeated or substituted. Q5 is separate, not a consumer prerequisite.

No phone privacy, policy, grant or capability changes are authorized by this map.
#3760 remains a separately gated phone/recovery proposal. Public release hold
#3706 is distinct from implementation landing.

This publication executes no tests, compiler, lint, provider, app or E2E work.
The map's proposed scope and estimates are planning, not runtime proof. Later
candidate changes need exact-source receipts and independent review; the map's
original bytes remain preserved.
