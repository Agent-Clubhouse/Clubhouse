/**
 * One terminal per PTY session, per window, owns the PTY's size (#2322).
 *
 * An agent can be mounted in several views at once (main view, canvas card,
 * popout, review).  When each one pushed its own container size, focusing
 * between them flipped the PTY size and every flip cost the child a full
 * repaint.  Only the owner sends resizes; the others follow the PTY size.
 *
 * The owner is the terminal the user last focused.  A terminal mounted while
 * the session has no owner becomes it, and when the owner unmounts ownership
 * passes to the most recently focused (or else most recently mounted) one.
 * Windows keep separate registries; between windows the focused window's
 * owner wins, because background windows don't send resizes.
 */

interface Member {
  token: symbol;
  /** Called when this terminal becomes the owner after the previous one left. */
  onOwn: () => void;
}

/** Per session, members ordered most recently focused (or mounted) first; [0] owns. */
const sessions = new Map<string, Member[]>();

/** Join a session's terminals.  Returns the unregister function. */
export function registerSizeOwner(sessionId: string, token: symbol, onOwn: () => void): () => void {
  let members = sessions.get(sessionId);
  if (!members) {
    members = [];
    sessions.set(sessionId, members);
  }
  // A new mount joins after the current owner, ahead of older non-owners.
  members.splice(members.length === 0 ? 0 : 1, 0, { token, onOwn });
  return () => {
    const list = sessions.get(sessionId);
    if (!list) return;
    const index = list.findIndex((m) => m.token === token);
    if (index < 0) return;
    list.splice(index, 1);
    if (list.length === 0) {
      sessions.delete(sessionId);
    } else if (index === 0) {
      list[0]!.onOwn();
    }
  };
}

/** Make `token` the session's owner (the user focused it). */
export function claimSizeOwner(sessionId: string, token: symbol): void {
  const members = sessions.get(sessionId);
  if (!members) return;
  const index = members.findIndex((m) => m.token === token);
  if (index <= 0) return;
  const [member] = members.splice(index, 1);
  members.unshift(member!);
}

/** Whether `token` owns the session's size.  Unregistered terminals do. */
export function isSizeOwner(sessionId: string, token: symbol): boolean {
  const members = sessions.get(sessionId);
  if (!members || members.length === 0) return true;
  if (!members.some((m) => m.token === token)) return true;
  return members[0]!.token === token;
}

/** Test helper: forget every registration. */
export function _resetSizeOwnersForTests(): void {
  sessions.clear();
}
