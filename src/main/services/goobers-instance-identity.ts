/**
 * Optional, defensive read of `<root>/config/manifest.yaml` for the two
 * display fields (§8.4's "Instance identity + config summary from disk")
 * that `instance.yaml`/`.instance-id` don't carry: `spec.instance.name` and
 * `spec.instance.environment` (e.g. "goobers-local" / "dev").
 *
 * `config/manifest.yaml` is NOT in §14.2's list of files we read, so its
 * absence is normal, not an error — an instance without one must still
 * validate and connect, just without a display name. This module therefore
 * targets exactly two scalar fields at a known path rather than parsing YAML
 * generally: this repo has no yaml/js-yaml dependency and nothing else in
 * `src/main` parses YAML, and adding a general parser for two fields is out
 * of proportion (and a dependency decision this module deliberately avoids).
 *
 * Read-only — never writes to the instance root (§10.3). Any failure (file
 * missing, unreadable, malformed, unexpected shape) degrades to "no identity
 * summary available" rather than an error state or a crash (§9.2).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface InstanceIdentitySummary {
  name?: string;
  environment?: string;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Targeted extractor for `spec:` -> `instance:` -> `name:`/`environment:`,
 * tracking indentation to stay within that nested block rather than matching
 * `name:`/`environment:` anywhere in the file. Returns `null` if the
 * `spec.instance` block isn't found at all; returns whatever subset of
 * `name`/`environment` it did find otherwise (a name present with no
 * environment is a valid partial result, not a failure).
 */
export function extractSpecInstanceIdentity(yamlText: string): InstanceIdentitySummary | null {
  const lines = yamlText.split(/\r?\n/);

  let specIndent = -1;
  let instanceIndent = -1;
  let name: string | undefined;
  let environment: string | undefined;

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;

    if (specIndent === -1) {
      if (indent === 0 && trimmedLine === 'spec:') {
        specIndent = indent;
      }
      continue;
    }

    if (instanceIndent === -1) {
      if (indent <= specIndent) {
        // Dedented out of spec: before ever finding an instance: sub-block.
        break;
      }
      if (trimmedLine === 'instance:') {
        instanceIndent = indent;
      }
      continue;
    }

    if (indent <= instanceIndent) {
      // Dedented out of spec.instance — nothing further to find.
      break;
    }

    const nameMatch = trimmedLine.match(/^name:\s*(.+)$/);
    if (nameMatch) {
      name = stripQuotes(nameMatch[1]);
      continue;
    }
    const envMatch = trimmedLine.match(/^environment:\s*(.+)$/);
    if (envMatch) {
      environment = stripQuotes(envMatch[1]);
    }
  }

  if (instanceIndent === -1) return null;
  if (name === undefined && environment === undefined) return null;
  return { name, environment };
}

/**
 * Read `<root>/config/manifest.yaml` and extract the identity summary.
 * Never throws — every failure mode (missing file, read error, malformed
 * content, unexpected shape) resolves to `null`.
 */
export async function readInstanceIdentitySummary(root: string): Promise<InstanceIdentitySummary | null> {
  const manifestPath = path.join(root, 'config', 'manifest.yaml');
  try {
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    return extractSpecInstanceIdentity(raw);
  } catch {
    return null;
  }
}
