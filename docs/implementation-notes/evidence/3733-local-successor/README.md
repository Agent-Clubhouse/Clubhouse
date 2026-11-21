# Evidence for the #3733 local successor

These are copies of raw command output. Only path prefixes and the author email host were replaced (`<worktree>`, `<deps-store>`, `<bisect-worktree>`, `<home>`, `<author-email>`). Files are saved as `.txt` because the repository ignores `*.log`.

| File | Content | Tree |
| --- | --- | --- |
| `validated-head.txt` | `git rev-parse HEAD` before the checks | `8cd17005cb30e382b0e5cb61c942aee780a37434` |
| `lint-scope.txt`, `lint.txt`, `lint.exit` | `git diff --name-only 69ef383ce HEAD -- '*.ts' '*.tsx' \| xargs eslint` | `8cd17005c`. Exit 0, 0 errors, 784 warnings. |
| `tsc.txt` | `time tsc --noEmit -p .` | `8cd17005c`. Exit 0. |
| `focused-tests.txt`, `focused.txt`, `focused.exit` | `vitest run --no-cache --maxWorkers=3` over 130 files | `8cd17005c`. 2 failed (F1), 5472 passed, 1 skipped. |
| `pre-focused.txt` | Same runner over the 107 lint-importer files | Uncommitted lint edits on `6af2bc3dc`, before `6fad09027`. 2 failed (F1). |
| `bisect.txt`, `bisect-steps.txt` | `git bisect run` of the F1 test file, `3b739fe5f` good, `b458b4c89` bad | First bad commit `9f2354d0d` |

`SHA256SUMS` lists the host-local raw files and these copies. The successor's non-documentation tree at the notes commit equals `8cd17005c`.
