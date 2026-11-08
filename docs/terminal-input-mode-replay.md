# Two input modes at a shortened replay head

Raw PTY history uses a whole-chunk cap. A replay of a shortened history
starts at `replayStart` (below). A per-session checkpoint
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

## A sequence or control string cut at the head

The tracker has read every evicted byte, so its parser state at the cut says
whether the retained output starts inside a CSI, OSC, DCS or other control
string. `replayStart` (`src/shared/pty-snapshot.ts`) uses it:

- Between sequences, the replay starts where the resync heuristic says.
- Inside one, it skips to the end of that fragment, then applies the resync
  heuristic from there. The skipped bytes go through a copy of the tracker,
  so `ESC[?20` evicted and `04htext` kept replays as `ESC[?2004h` + `text`,
  as the full stream would show it.
- A new ESC or C1 introducer abandons the fragment, as it does in xterm, so the
  replay starts at it.
- An OSC, DCS or other string that runs past the end of the kept output
  replays nothing, since the terminal would print none of it.
- An alt-screen switch completed by the skipped fragment is carried in the
  prefix too.

The in-memory xterm oracle cases in `pty-input-mode-replay.test.ts` compare
each of these with the full stream.

## Remaining limits

C0 and C1 controls executed in the middle of a cut sequence (a line feed
inside a CSI, or NEL) are skipped with it. When a string runs past the kept
output, the replay terminal starts in ground state, so the rest of that string
arriving live afterwards prints as text where the original terminal swallows
it. That needs all of the kept output to sit inside one unterminated string. This makes no claim for other terminal modes,
historical resize reconstruction in an activation mirror, OS PTYs or Go's
paste/key encoding. There is no live-terminal or phone acceptance here.
