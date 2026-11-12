export const IMPORT_EFFECTS = [
  'Create the exact new destination directory and a shallow Git checkout of the reviewed branch and commit.',
  'Download repository objects using existing authorized Git credentials. Do not initialize submodules, run hooks, filters, setup or repository code.',
  'Register the checkout as a Clubhouse project and add Clubhouse ignore rules to .gitignore.',
  'Do not create, connect, configure or start an agent.',
] as const;

export interface ImportInput {
  url: string;
  destination: string;
  branch?: string;
}

export interface RemoteIdentity {
  url: string;
  defaultBranch: string;
  branch: string;
  commit: string;
  headCommit: string;
}

export interface ImportPlan extends RemoteIdentity {
  id: string;
  agentId: string;
  destination: string;
  parent: string;
  parentIdentity: string;
  createdAt: number;
  expiresAt: number;
  effects: readonly string[];
}

export type ImportPhase = 'reserved' | 'initializing' | 'fetching' | 'checking_out' | 'cloned' | 'registering'
  | 'completed' | 'partial' | 'cancelled' | 'interrupted' | 'failed';

export interface ImportReceipt {
  id: string;
  plan: ImportPlan;
  phase: ImportPhase;
  updatedAt: number;
  /** Filesystem identity of the directory created exclusively for this import. */
  directoryIdentity?: string;
  cloneCompleted: boolean;
  projectId?: string;
  gitignore?: 'updated' | 'unchanged' | 'failed';
  reason?: string;
  failedAt?: ImportPhase;
  progress?: number;
  agentCreated: false;
  agentStarted: false;
}

export interface ImportState {
  version: 1;
  plans: ImportPlan[];
  receipts: ImportReceipt[];
}

export class ImportError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export const ACTIVE_PHASES: ReadonlySet<ImportPhase> = new Set([
  'reserved', 'initializing', 'fetching', 'checking_out', 'cloned', 'registering',
]);

export function directoryIdentity(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`;
}

export function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function validateGithubUrl(input: string): string {
  // Match the source, not a URL parser's normalized interpretation of dot segments, escapes or userinfo.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/.exec(input);
  if (!match || /[\0-\x20\x7f]/.test(input) || match[1].endsWith('-') || match[1].includes('--')
    || !/[A-Za-z0-9_]/.test(match[2]) || match[2].startsWith('-') || match[2].includes('..')) {
    throw new ImportError('unsupported_url', 'Use only https://github.com/owner/repository (optionally .git), without credentials, escapes, query or fragment. SSH and other hosts are not supported.');
  }
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

export function validateImportBranch(branch: string): string {
  if (branch.length > 200 || /[\0-\x20\x7f]/.test(branch) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
    || branch.includes('..') || branch.includes('//') || branch.includes('@{')
    || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new ImportError('unsupported_branch', 'Choose an existing branch with a plain Git ref name (up to 200 characters); this importer does not accept revisions, options or special ref expressions.');
  }
  return branch;
}
