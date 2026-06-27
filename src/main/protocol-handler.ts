/**
 * Custom protocol handler — pure parsing & resolution logic.
 *
 * The app registers the `clubhouse://` scheme with the OS so links can drive
 * the app. This module contains the side-effect-free core (URL parsing,
 * project matching, command resolution) so it can be unit-tested without
 * Electron. The Electron wiring lives in `protocol-service.ts`.
 *
 * Supported links:
 *   clubhouse://open-file?path=<absolute file path>
 *     → reveal the file in the file browser of the project whose root contains it
 *   clubhouse://open-folder?path=<absolute folder path>
 *     → add the folder as a new project
 */

import * as path from 'path';
import { Project, ResolvedProtocolAction } from '../shared/types';

export type { ResolvedProtocolAction };

/** The OS-level scheme the app registers. */
export const PROTOCOL_SCHEME = 'clubhouse';

/** A command parsed from a protocol URL, before resolution against projects. */
export type ProtocolCommand =
  | { kind: 'open-file'; filePath: string }
  | { kind: 'open-folder'; folderPath: string };

/**
 * Parse a `clubhouse://` URL into a command. Returns null for anything that
 * isn't a well-formed, supported link (wrong scheme, unknown command, missing
 * path). The scheme and command are matched case-insensitively.
 */
export function parseProtocolUrl(url: string): ProtocolCommand | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // URL keeps the trailing ':' on the protocol, e.g. "clubhouse:".
  if (parsed.protocol.toLowerCase() !== `${PROTOCOL_SCHEME}:`) return null;

  // For clubhouse://open-file?... the command is the host. Some platforms hand
  // back clubhouse:open-file?... (no slashes) where it lands in pathname.
  const command = (parsed.hostname || parsed.pathname.replace(/^\/+/, ''))
    .replace(/\/+$/, '')
    .toLowerCase();

  const rawPath = parsed.searchParams.get('path');
  if (!rawPath) return null;
  // Reject whitespace-only paths.
  if (!rawPath.trim()) return null;

  switch (command) {
    case 'open-file':
      return { kind: 'open-file', filePath: rawPath };
    case 'open-folder':
      return { kind: 'open-folder', folderPath: rawPath };
    default:
      return null;
  }
}

/**
 * Pull the first `clubhouse://` argument out of a process argv array. Windows
 * and Linux deliver protocol activations as a command-line argument (via the
 * `second-instance` event or the initial launch argv) rather than `open-url`.
 */
export function extractProtocolUrlFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.toLowerCase().startsWith(`${PROTOCOL_SCHEME}://`)) {
      return arg;
    }
  }
  return null;
}

/** Normalize a path for prefix comparison without a trailing separator. */
function normalizeRoot(p: string): string {
  const resolved = path.resolve(p);
  // path.resolve already strips trailing separators except for the FS root.
  return resolved;
}

/**
 * Find the project whose root contains the given file. When projects are
 * nested (a file lives under more than one project root), the deepest — most
 * specific — root wins. Returns the matched project plus the file's path
 * relative to that root, using forward slashes to match the file browser's
 * relative-path convention. Returns null when no project contains the file.
 */
export function findProjectForFile(
  filePath: string,
  projects: readonly Project[],
): { project: Project; relativePath: string } | null {
  const target = path.resolve(filePath);

  let best: { project: Project; rootLen: number } | null = null;

  for (const project of projects) {
    if (!project.path) continue;
    const root = normalizeRoot(project.path);

    // The file must equal the root or sit strictly underneath it. Comparing
    // against `root + sep` prevents `/foo/bar-baz` from matching root `/foo/bar`.
    const isUnder = target === root || target.startsWith(root + path.sep);
    if (!isUnder) continue;

    if (!best || root.length > best.rootLen) {
      best = { project, rootLen: root.length };
    }
  }

  if (!best) return null;

  const relativePath = path
    .relative(normalizeRoot(best.project.path), target)
    .split(path.sep)
    .join('/');

  return { project: best.project, relativePath };
}

/**
 * Resolve a parsed command into a renderer-dispatchable action using the
 * current project list. `open-folder` passes through untouched (the renderer
 * adds the project); `open-file` is resolved to its owning project here.
 */
export function resolveProtocolCommand(
  command: ProtocolCommand,
  projects: readonly Project[],
): ResolvedProtocolAction {
  if (command.kind === 'open-folder') {
    return { kind: 'open-folder', folderPath: command.folderPath };
  }

  const match = findProjectForFile(command.filePath, projects);
  if (!match) {
    return { kind: 'open-file-not-found', filePath: command.filePath };
  }
  return { kind: 'open-file', projectId: match.project.id, relativePath: match.relativePath };
}

/**
 * Convenience: parse a URL and resolve it against the project list in one
 * step. Returns null when the URL is not a valid, supported protocol link.
 */
export function resolveProtocolUrl(
  url: string,
  projects: readonly Project[],
): ResolvedProtocolAction | null {
  const command = parseProtocolUrl(url);
  if (!command) return null;
  return resolveProtocolCommand(command, projects);
}
