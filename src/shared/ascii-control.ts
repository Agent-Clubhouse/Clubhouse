/** C0 controls (U+0000–U+001F) and DEL, checked per UTF-16 code unit like a non-`u` regex class. */
const isC0 = (code: number) => code < 0x20;
const isAsciiControlCode = (code: number) => code < 0x20 || code === 0x7f;

/** Same as `/[\x00-\x1f\x7f]/.test(value)`. */
export function hasAsciiControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (isAsciiControlCode(value.charCodeAt(i))) return true;
  return false;
}

/** Same as `/[\x00-\x1f]/.test(value)`; DEL is allowed. */
export function hasC0Control(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (isC0(value.charCodeAt(i))) return true;
  return false;
}

/** Same as `value.replace(/[\x00-\x1f\x7f]/g, replacement)` for a literal replacement. */
export function replaceAsciiControl(value: string, replacement = ' '): string {
  let out = '';
  for (let i = 0; i < value.length; i++) out += isAsciiControlCode(value.charCodeAt(i)) ? replacement : value[i];
  return out;
}
