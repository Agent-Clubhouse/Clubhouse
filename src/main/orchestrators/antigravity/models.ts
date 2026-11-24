/**
 * Antigravity model discovery (#3790): `agy models`, run in the empty probe
 * folder. It sends no prompt.
 *
 * The headless docs (https://antigravity.google/docs/cli/headless/, read
 * 2026-11-23) show one model per line: a slug padded to a column, then a
 * display name. The effort is part of the slug and the name
 * (`gemini-4-neon-high   Gemini 4 Neon (High)`), and the page lists no
 * per-model effort field, so none is invented here.
 *
 * Format boundary: a model line is a slug, at least two spaces (the padded
 * column), then a name. A line with one column or a single space between words
 * (`Warning: ...`, `Available models:`) is not a model line and is skipped; a
 * lone `...` (the docs' own elision) is skipped too. Slug characters are the
 * ones the documented slugs use plus `/` and `_`; nothing narrows by prefix.
 * Output with more than MAX_MODELS model lines is refused whole, not cut off.
 */

import { execFile } from 'child_process';
import type { ModelInfo } from '../types';
import type { ModelProbeContext } from '../model-probes';
import { getShellEnvironment } from '../../util/shell';
import { resolveProcessLaunch } from '../../util/process-launch';

/** More than any real list; output past it is refused rather than half-parsed. */
const MAX_MODELS_OUTPUT_BYTES = 256 * 1024;
const MAX_MODELS = 500;

/** Slugs are passed to `--model`; anything that could read as a flag or carry spaces is refused. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MODEL_LINE = /^(\S+) {2,}(\S.*)$/;

/**
 * Parse `agy models` output. Returns null when no line is a model, so the
 * caller falls back; a line outside the format is skipped, never guessed into
 * a slug. Throws when there are more model lines than MAX_MODELS.
 */
export function parseAgyModels(stdout: string): ModelInfo[] | null {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ').trim();
    const match = MODEL_LINE.exec(line);
    if (!match) continue;
    const [, slug, name] = match;
    if (!SLUG.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    if (models.length === MAX_MODELS) throw new Error(`agy models listed more than ${MAX_MODELS} models`);
    models.push({ id: slug, label: name.trim() });
  }
  return models.length ? models : null;
}

/** `agy models` in the probe folder, with the login shell's env plus `ctx.env`. */
export function probeAgyModels(ctx: ModelProbeContext): Promise<ModelInfo[] | null> {
  const env = { ...getShellEnvironment(), ...ctx.env };
  const launch = resolveProcessLaunch(ctx.binary, ['models'], env);
  return new Promise((resolve, reject) => {
    execFile(launch.binary, launch.args, {
      cwd: ctx.cwd,
      env,
      shell: false,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      timeout: ctx.timeoutMs,
      maxBuffer: MAX_MODELS_OUTPUT_BYTES,
      signal: ctx.signal,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) {
        reject(new Error(`agy models failed: ${err.message.split('\n')[0]}`));
        return;
      }
      resolve(parseAgyModels(String(stdout)));
    });
  });
}
