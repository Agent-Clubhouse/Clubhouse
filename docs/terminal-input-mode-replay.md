# Two input modes at a shortened replay head

This is a bounded slice of #2743, not full issue closure. Raw PTY history still
uses the existing whole-chunk cap and resync heuristic. A per-session checkpoint
tracks application cursor and bracketed paste mode through evicted output. A
copy consumes the prefix discarded by resync; fixed enables for the resulting
head state precede retained output. Retained disables and resets then win in
their original order. Untruncated data and raw/live output are unchanged.

Annex activation seeds from the same snapshot data and seq. The existing xterm
serializer already writes these enabled modes for full and byte-fitted output.
No wire fields or renderer interpretation change. Sequence numbers count only
actual PTY output; replay size offsets include synthetic prefix characters.
Fresh replay terminals start with both modes disabled, as the existing
serializer contract assumes. A dirty reused terminal is not covered.

The scanner retains scalar state, not raw escape strings. Its mode grammar
follows locked xterm 6: CSI private 1/2004 h/l, combined primary parameters
(first 32, saturating at 2^31-1), C1 introducers, CAN/SUB, RIS and DECSTR. xterm's
DECSTR resets both modes. OSC/DCS plain text like `[?2004h` does not set a mode;
ESC terminates those strings and begins an actual subsequent escape command.
Only these two input modes are checkpointed. The existing alt-screen tracker,
resync policy, frame limits, private-shell gates and PTY input remain in place.

## Explicit remaining boundary defect

If evicted output ends in `ESC[?20` and the retained output is `04htext`,
`resyncOffset` returns zero: no ESC or LF occurs in its bounded search. The
checkpoint has not yet seen a completed mode command, so replay remains
`04htext`. A fresh terminal shows those characters and has bracketed paste off;
the original full stream shows `text` with bracketed paste on. The scanner can
consume that split stream correctly, but the truncated replay lacks its
introducer. The labeled manager and in-memory characterization cases deliberately
retain this defect; passing them is not proof of complete split-boundary recovery.
No pending-CSI reinsertion or resync redesign is included.

Similarly, the existing ESC/LF heuristic is not a general restoration of parser
state for a head cut inside OSC/DCS or another control string. The scanner does
not treat ordinary string payload as commands, but a replay starting mid-string
can still be interpreted differently. This slice makes no claim for arbitrary
control fragments, other terminal modes, historical resize reconstruction in an
activation mirror, OS PTYs or Go's paste/key encoding. Those need separate
disposition and evidence. There is no live-terminal or phone acceptance here.
