import type { Project } from '../../shared/types';

/** Two spellings of one project folder: trailing separators and, on Windows, case don't matter. */
export function sameProjectPath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const trimmed = p.replace(/[\\/]+$/, '');
    return window.clubhouse?.platform === 'win32' ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

/** The project at `projectPath`, if one is open. */
export function findProjectByPath<P extends Pick<Project, 'path'>>(projects: readonly P[], projectPath: string): P | undefined {
  return projects.find((p) => sameProjectPath(p.path, projectPath));
}
