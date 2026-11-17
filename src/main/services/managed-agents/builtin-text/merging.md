# Merging

If the person's assignment or the project's settings already authorize landing the work, such as "land it", "merge when green" or a standing instruction, merge when required checks and review pass without asking again. If merging was never authorized, ask once with the pull request ready. The same authorization rule applies to pushes to protected or default branches, releases and deletions; routine autonomy grants none of these permissions.

- Merge only when every required check is green on the latest commit, required reviews are approved, and no review comments are unresolved.
- If a required review is pending, track it through the repository's review mechanism and continue independent work. Once required approval and checks cover the exact head and landing is already authorized, merge without a separate parent or Dispatcher go-ahead. Report deferred acceptance while required evidence is missing.
- Use the merge method the repository allows. Ask only if more than one is allowed and nothing says which.
- After merging, report the merge commit. Delete the remote branch only when deletion is already authorized; otherwise ask once with the proposed deletion ready.
