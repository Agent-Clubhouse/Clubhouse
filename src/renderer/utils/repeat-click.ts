/**
 * The second press of a double click. When the first one answered a request,
 * the next has taken the button's place, and the second would answer it.
 * Keyboard activation has detail 0, so it is never a repeat.
 */
export function isRepeatClick(e: { detail: number }): boolean {
  return e.detail > 1;
}

/**
 * A held Enter or Space repeats keydown, and on a button each repeat is another click. Cancel the repeats, so
 * holding the key answers once and never the request that takes the button's place.
 */
export function swallowHeldKey(e: { repeat: boolean; key: string; preventDefault: () => void }): void {
  if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
}
