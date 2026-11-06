# Project settings navigation and Close

Settings lists projects in their persisted manual order, the same flat order used
by the classic project rail. Renaming a project does not sort it. A newly opened
project is appended, and closing one removes that entry. Reordering preserves the
selected Settings scope, its expanded pages, keyboard focus and unsaved editor
text.

The new sidebar has a different presentation: pinned, active and idle sections,
with either manual or Recent ordering inside those sections. Those groups and
activity changes do not reshuffle Settings. There is no separate Settings order
preference. The Settings list states this distinction beside its Projects label.

Close project in the new sidebar, classic rail and Project settings uses one
confirmation flow. It unregisters the captured project through the existing
project removal API. Cancellation makes no change. Close does not reset project
settings, delete project files or stop running agents. Mark inactive remains a
separate sidebar action. Satellite project menus have no local Close action.

Project settings leaves its own page at confirmation only if that scope is still
being viewed. Pending removal must not navigate after the user has moved on.
Removal failure shows a fixed error message and leaves registration intact.

## Issue disposition and verification

- #2852: restore the missing sidebar Close action with shared behavior.
- #2853: document and label the existing persisted manual Settings order, with
  regressions for reorder, display-name changes, add/remove, Recent/group
  independence, selected/expanded scope, keyboard order and unsaved edits.
- #2854: reported, unconfirmed. Synthetic tests of the actual Settings destination
  pass without a routing change. They cover prior app scope, another project's
  prior page, an inactive clicked project, and real App/ChromeBody effects after
  project switching and display refresh. This evidence does not reproduce or
  resolve the reported user-visible failure. A human reproduction with exact
  prior navigation steps is still needed.

All fixtures use synthetic projects and mocked IPC. No local app launch, real
project removal, provider invocation or visual review is part of this evidence.
