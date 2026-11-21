# Native diagnostic attribution correction

Independent QA37c2299384696ab0fadd0df38e10ca94780c3830 observed G2/G4
with its own gh logs/ZIP/JUnit download. The raw preserved pages XML contains
a testcase system-out for the unflushed-process/reopen/reuse discriminator.
Historical d0c9/0b433 REVIEW.md incorrectly stated captured child stdout absent;
that wording is corrected in this successor without modifying the original raw
XML, source0e6, hosted run44926471482 or prior commits.

The recorded guarded outer fixture code is0. Nested preparation process
exits77 with signalnull after writing a prepared root and skippedFlushtrue.
Reopen/reuse reports pendingBeforeFlush3, syncPosition2, prefixPosition3,
pendingAfterFlush0 and PASS. This is actual child execution on this Windows
runner and ordering/bookkeeping observation, not a powerloss guarantee.

The recorded skip-dirty mutant fixture code is2. Its nested preparation also
exits77; reuse reports pendingBeforeFlush2, syncPosition2, prefixPosition-1,
pendingAfterFlush0, followed by the explicit missing-prefix safety assertion.
This is an executed negative control, not a production incident.

Other process/rename/symlink testcases pass as JUnit assertions; do not invent
extra child diagnostics for cases lacking them. The native no-override reuse
testcase passes without emitting directoryDurability or filesystem type.
Checkout attribution is ordinary Actions log+canonical five-Git-blob equality,
not an atomic hosted working-tree seal. Prior platform/FS/whole-Q5 limits remain.
