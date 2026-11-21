# Dispatcher Actions note correction: evidence

Product commit `ad46882fa8fa44a796bf4125bc62f77879f4ef23` on `main` `be0091d16`. It changes `actions/selected-details-page.ts` (the note text chosen by `subject.dispatcher`) and adds one test.

- **RED first:** the new test failed on the old note text before the change.
- **Mutation** (`mutation-raw.txt`): forcing the old text (`subject.dispatcher ?` → `false ?`) fails only the new test (1 failed, 233 passed across the two affected files). The restore was byte-identical, with sha256 `d200323c9f9cf2f78bd8bc96d61c8fe39ce204f33418452b4a6eb46781b248b7` equal to the committed blob.
- **Exact-head run on `ad46882fa`** (`run.sh.txt`):
  - full vitest with `--no-cache --maxWorkers=4` and a fresh TMPDIR: exit 0 (1468 files, 35868 tests);
  - `tsc --noEmit`: exit 0;
  - scoped eslint: exit 0.
  - The head, tree and clean status were identical before and after. The touched source hashes equal the commit blobs.
  - This full run had already started when the parent set proportional proof for text-only fixes. Later text-only fixes use targeted proof.
- **Portability:** the committed copies are path-normalized (`<worktree>`, `<TMPDIR>`, `<home>`). `raw-originals.sha256` holds the digests of the host-local originals, which aren't in the repo. `SHA256SUMS` seals the committed copies.
