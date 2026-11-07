/**
 * Where a CLI reads a worktree's skills, relative to the worktree, with
 * forward slashes: `skillsRoot` when the provider sets one, else
 * `<configDir>/<skillsDir>`. Codex reads repository skills from
 * `.agents/skills`, which Copilot reads too, not from its config folder.
 */
export function skillsFolderOf(conv: { configDir: string; skillsDir: string; skillsRoot?: string }): string {
  return conv.skillsRoot ?? `${conv.configDir}/${conv.skillsDir}`;
}
