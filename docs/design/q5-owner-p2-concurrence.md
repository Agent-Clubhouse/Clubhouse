# Q5 journal concurrence on frozen P2 interface

Read-only contract assessment, not implementation/test/consumer or ACK approval.
P2 source282fc55001f086b169358e26bf1acfebdbfde233,
`docs/design/q5-runtime-p2-chat-binding.md`, SHA256
414f6cb62bb3e94956c9006f4a521e08e2870c1b3d4df0d7eddebdc56cb6a5cd
was read through gh and the content hash verified. Landed P1 mainc43ffb37d
and private owner source413ca8f0a are separate; the latter is unvalidated source.

No concrete journal-interface contradiction identified:

- Actual P1 and P2 retain `entered|journal_owned` and the shared synchronous
  `journal_owned|claimed {committedOutcome}` loss shape. Registry/original-resource
  ownership prechecks do not interpret a pre-entry false transport ticket as
  nonentry. Structural clones do not gain authority.
- Host invokes one issued marker and retires through one coordinator loss owner.
  `journal_owned` adds no loss/replay. Q5 ACK-first ownership remains a real
  unaccepted source/proof dependency; P2 does not pretend the legacy71 API has it.
- After early adapter entry, any delayed native refusal or unverified resolution
  is UNKNOWN. No tracked Codex second transport leg or refund from false ticket.
- A constructor refusal after durable intent does not erase it or fabricate
  zero submission. If no handoff/hook was created, Q5 reconciles its exact attempt
  using its own claim rather than waiting for a nonexistent runtime callback.
- Publication guards and mode projections do not become journal authority.
  Historical receipt sink remains exact original attempt-only, without current
  session/member/UI publishers. Retirement does not prematurely discard that
  bounded source; it does not promise SDK drain or provider processing either.
- Existing delivery mode/Action ACK/catch retry path remains barred from the new
  trusted field until P5. No real caller, provider mapper, wake or phone activation
  is approved by matching these signatures. Claude/Copilot/PT Y fences remain
  separately owned (P4/P3); nothing is enabled by adding an optional type.

Concrete correction outside the semantic interface: P2's final evidence section
says types/lint use min4. Standing user resource rules require compiler6GiB,
tests/lint4GiB, maxWorkers2 total, actual desktop-test-gate and >=60s on75 refusal.
Use compiler6 and correct that text before execution; no threshold waiver or
permission request follows from this review. Parent was sent this exception.

No shared type/chat/Codex/lifecycle or delivery-test hunk is edited by this note.
Private ledger/owner tests continue under their own exact source receipts; no
P1 approval or earlier9be proof transfers to current owner implementation.
