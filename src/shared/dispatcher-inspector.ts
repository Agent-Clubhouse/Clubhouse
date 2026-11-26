/**
 * The Dispatcher inspector (#3912): a read-only look, in Dispatcher debug, at
 * what the Dispatcher works from: its instruction files, its skills and its
 * memory. Main reads everything (dispatcher-inspector.ts); the renderer only
 * shows it. Local only, and never sent to telemetry, logs or feedback.
 */
import type { DispatcherRole } from './dispatcher-behavior';

/** Why a file couldn't be shown. Codes only: safe to log. */
export type InspectorFileError =
  /** A link in its path: links are never followed. */
  | 'link'
  /** Not a plain file (a folder, a device). */
  | 'not_file'
  /** Bigger than the inspector reads at all. */
  | 'too_large'
  /** It changed while being read (another file was put in its place). */
  | 'changed'
  /** It has more than one hard link, so its content may be a file outside the folder. */
  | 'hard_link'
  /** The path a CLI names for it is outside the Dispatcher's folder, so it isn't read. */
  | 'outside'
  /** Anything else the file system refused. */
  | 'unreadable';

/** One file as the inspector found it. Content is cut at its cap, never read past it. */
export interface InspectorFile {
  /** Absolute path. */
  path: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  content?: string;
  /** The content was cut at the cap; `size` is the whole file's. */
  truncated?: boolean;
  error?: InspectorFileError;
}

/**
 * Which CLI a role uses (#3912). `saved` is what its record names, so what the
 * next start writes; `running` is what its live session started on. They
 * differ while a CLI switch waits for the next start.
 */
export interface InspectorRoleSession {
  /** Null before that agent exists. */
  saved: string | null;
  /** Null while it isn't running. */
  running: string | null;
  /**
   * When the running session was spawned in this app run (ms), or null while it
   * isn't running. Memory read or written at or after it was "loaded this
   * session". A conversation resumed across a respawn counts from the respawn.
   */
  startedAt: number | null;
}

export type InspectorSessions = Record<DispatcherRole, InspectorRoleSession>;

/** One CLI's instructions file for one role. */
export interface InspectorInstructionFile extends InspectorFile {
  role: DispatcherRole;
  /** The CLI's provider id. */
  provider: string;
  /** The running session's CLI, or the saved one while the role isn't running: the file it works from. */
  active: boolean;
  /** The CLI the role's record names: the next start writes this file. */
  saved: boolean;
  /** The CLI the live session started on. */
  running: boolean;
}

export interface InspectorInstructions {
  sessions: InspectorSessions;
  files: InspectorInstructionFile[];
}

/** An installed skill, listed without its content. */
export interface InspectorSkill {
  role: DispatcherRole;
  /** The skill's folder name. */
  name: string;
  /** Absolute path of its SKILL.md. */
  path: string;
  size?: number;
  mtimeMs?: number;
  /** Clubhouse's manifest in that folder names it, so Clubhouse wrote it. */
  managed: boolean;
  error?: InspectorFileError;
}

export interface InspectorSkills {
  skills: InspectorSkill[];
  /** More folders than the list holds. */
  truncated?: boolean;
  /** A role whose skills folder couldn't be listed; the other role is still listed. */
  errors?: Partial<Record<DispatcherRole, InspectorFileError>>;
}

/** A memory page in the listing. */
export interface InspectorMemoryPageEntry {
  /** Relative to the memory folder, with forward slashes. */
  page: string;
  size?: number;
  mtimeMs?: number;
}

export interface InspectorMemoryIndex {
  /** False when the memory folder isn't there yet. */
  exists: boolean;
  /** False when there is no index.md; `text` is then empty. */
  indexExists: boolean;
  /** index.md, cut to the memory reader's caps (the 8 KB index cap, then 64,000 chars). */
  text: string;
  truncated?: boolean;
  pages: InspectorMemoryPageEntry[];
  pagesTruncated?: boolean;
}

export interface InspectorMemoryPage {
  page: string;
  text: string;
  truncated?: boolean;
  size?: number;
  mtimeMs?: number;
  /** A topic page's Created and Updated headers (#3218), as written. */
  created?: string;
  updated?: string;
}

/** One page in the access record (#3219). */
export interface InspectorMemoryAccessEntry {
  page: string;
  lastRead?: number;
  lastWrite?: number;
  lastWriter?: string;
  reads: number;
  writes: number;
}

export interface InspectorMemoryAccess {
  /** Each role's CLI and session start, to tell what was loaded this session. Both roles share one record. */
  sessions: InspectorSessions;
  /** Most recent first, by last read or write. */
  entries: InspectorMemoryAccessEntry[];
  /** Pages in the record in all. */
  total: number;
  truncated?: boolean;
  error?: InspectorFileError | 'invalid';
}
