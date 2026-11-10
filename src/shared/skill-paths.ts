/**
 * Relative paths inside a skill bundle (#3247). One rule for the editors in
 * the renderer and the catalog validator in main, so a path the dialog accepts
 * is one main saves and delivery writes.
 */

export const SKILL_ENTRYPOINT = 'SKILL.md';
export const MAX_SKILL_PATH_CHARS = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const SEGMENT_ILLEGAL_RE = /[<>:"|?*\\/]/;
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** One folder or file name that every file system can hold, and that can't climb out. */
export function isSafeSkillPathSegment(segment: string): boolean {
  return !!segment
    && segment !== '.'
    && segment !== '..'
    && !SEGMENT_ILLEGAL_RE.test(segment)
    && !CONTROL_CHARS_RE.test(segment)
    && !WINDOWS_DEVICE_RE.test(segment)
    && !/[. ]$/.test(segment);
}

/** How file systems and CLIs may see two spellings as one. */
function key(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * Why `path` can't join a bundle holding `existing`, or null when it can.
 * `replacing` is the member being renamed, which doesn't clash with itself.
 * A file can't share a name with another file or with a folder.
 */
export function skillPathError(path: string, existing: readonly string[], replacing?: string): string | null {
  if (!path || path.length > MAX_SKILL_PATH_CHARS || path !== path.normalize('NFC') || !path.split('/').every(isSafeSkillPathSegment)) {
    return 'Use a portable path relative to this bundle, like assets/note.md.';
  }
  const want = key(path);
  const clash = existing.find((other) => {
    if (other === replacing) return false;
    const have = key(other);
    return have === want || have.startsWith(`${want}/`) || want.startsWith(`${have}/`);
  });
  return clash ? `That path conflicts with ${clash}.` : null;
}

/**
 * Bundle paths for dropped or picked files, given as paths from what was
 * chosen (`sample-skill/SKILL.md`, `assets/note.md`, `run.sh`). A top folder
 * that holds SKILL.md directly is a whole skill: its name is stripped and
 * offered as the skill name. Any other folder is a supporting folder and
 * keeps its name. Only one skill comes in at a time: with two or more skill
 * folders, none is stripped and `skillFolders` names them so the caller can say so.
 * Names are made NFC, as macOS can hand them over decomposed.
 */
export function planSkillImport(paths: readonly string[]): { paths: string[]; skillName: string | null; skillFolders: string[] } {
  const parts = paths.map((p) => p.normalize('NFC').replace(/\\/g, '/').split('/').filter(Boolean));
  const skillFolders = [...new Set(parts.filter((p) => p.length === 2 && p[1] === SKILL_ENTRYPOINT).map((p) => p[0]))];
  const skillName = skillFolders.length === 1 ? skillFolders[0] : null;
  return {
    paths: parts.map((p) => (p.length > 1 && p[0] === skillName ? p.slice(1) : p).join('/')),
    skillName,
    skillFolders,
  };
}
