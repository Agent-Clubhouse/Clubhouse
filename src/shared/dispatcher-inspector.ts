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
  /** It changed while being read. */
  | 'changed'
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

/** One CLI's instructions file for one role. */
export interface InspectorInstructionFile extends InspectorFile {
  role: DispatcherRole;
  /** The CLI's provider id. */
  provider: string;
  /** The CLI this role runs on now. Every other CLI's file is inactive: it isn't read by a start. */
  active: boolean;
}

export interface InspectorInstructions {
  /** The CLI each role runs on, or null before that agent exists. */
  active: Record<DispatcherRole, string | null>;
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
  /** index.md, cut to the memory reader's caps. */
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
  /** Most recent first, by last read or write. */
  entries: InspectorMemoryAccessEntry[];
  /** Pages in the record in all. */
  total: number;
  truncated?: boolean;
  error?: InspectorFileError | 'invalid';
}
