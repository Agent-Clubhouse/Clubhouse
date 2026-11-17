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

/**
 * A key a card answers a request with: Enter, Escape and the digits that pick an option (Space only activates a focused button, which `swallowHeldKey` covers). Holding one repeats
 * it; holding anything else (Arrow, Page Down, Tab) is the person scrolling or moving, and must keep working.
 */
export function isAnsweringKey(key: string): boolean {
  return key === 'Enter' || key === 'Escape' || (key.length === 1 && key >= '1' && key <= '9');
}
