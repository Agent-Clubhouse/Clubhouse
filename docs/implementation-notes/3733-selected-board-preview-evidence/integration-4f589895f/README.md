# #13 selected-board preview: integration proof on main 4f589895f7c113dda11f5212992c942209fcfe5b

This is a risk-targeted proof on the exact merge commit `0e847049916beeb92e0be1368e7974c31282284a` (tree `ef34c30841e845ef71cbaef89b20692fb732b68f`). It merges main `4f589895f7c113dda11f5212992c942209fcfe5b` into the sealed preview `bf4796b18ffc09065eedc0e22cf5f2ab9509ff8c` (implementation `ea9ca416922129531fccbf7b11b828a26be9aec4`) by ancestry, with no rebase and no conflicts.

- **What main changed under the preview:** the four Annex client and server files (the reverse-transport admission work). The preview's client hunks are disjoint from those lines.
- **vitest:** the 42 test files that import a touched module (`scope.txt`), with `--no-cache --maxWorkers=3` and a fresh TMPDIR. Exit 0, 2301 tests.
- **tsc:** `tsc --noEmit`, exit 0.
- **eslint:** the 25 source files differing from main, exit 0.
- **Identity:** head, tree and clean status were identical before and after. The 25 source hashes equal the commit blobs.
- **Not covered:** this isn't a full suite, and no hosted CI has run. Independent implementation review is still outstanding. Canvas-tab navigation is still OPEN.
- **Portability:** the copies are path-normalized. `raw-originals.sha256` holds the host-local digests. `SHA256SUMS` seals the committed copies.
