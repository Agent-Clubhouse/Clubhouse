#!/usr/bin/env node
/** Rebuild a builder-shaped export from the built-in manifest and shipped text.
 * Usage: node scripts/export-builtin-text.mjs <empty export folder>
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textDir = path.join(root, 'src', 'main', 'services', 'managed-agents', 'builtin-text');

export function exportBuiltinText(exportDir, sourceDir = textDir) {
  if (existsSync(exportDir) && readdirSync(exportDir).length) {
    throw new Error('The export folder must be empty.');
  }
  const manifest = JSON.parse(readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
  const write = (kind, doc) => {
    const dir = path.join(exportDir, kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${doc.id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  };
  for (const [order, block] of manifest.blocks.entries()) {
    write('blocks', { id: block.id, name: block.name, description: block.description, order,
      origin: 'builtin', status: block.retired ? 'cut' : 'ok', text: readFileSync(path.join(sourceDir, block.file), 'utf8') });
  }
  for (const [order, skill] of manifest.skills.entries()) {
    write('skills', { id: skill.id, name: skill.name, description: skill.description, folder: skill.skillName, order,
      origin: 'builtin', status: skill.retired ? 'cut' : 'ok', text: readFileSync(path.join(sourceDir, skill.file), 'utf8') });
  }
  for (const [order, template] of manifest.templates.entries()) {
    const { orchestration, ...settings } = template.settings;
    write('templates', { id: template.id, name: template.name, description: template.description,
      blocks: template.blocks, skills: template.skills ?? [], settings: { ...settings, ...orchestration }, order,
      origin: 'builtin', status: template.retired ? 'cut' : 'ok' });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2];
  if (!dest || process.argv.length !== 3) {
    console.error('Usage: node scripts/export-builtin-text.mjs <empty export folder>');
    process.exitCode = 1;
  } else {
    try { exportBuiltinText(path.resolve(dest)); }
    catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
  }
}
