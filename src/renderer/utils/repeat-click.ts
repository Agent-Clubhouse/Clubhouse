/**
 * The second press of a double click. When the first one answered a request,
 * the next has taken the button's place, and the second would answer it.
 * Keyboard activation has detail 0, so it is never a repeat.
 */
export function isRepeatClick(e: { detail: number }): boolean {
  return e.detail > 1;
}
