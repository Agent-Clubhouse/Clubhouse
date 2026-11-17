/**
 * Structural guard for #3664: a write is a person's only at a real person
 * entry point. The MCP AST guard (clubhouse-mcp/tools/group-project-author-boundary.test.ts)
 * covers agent tools; this one covers everything else in main.
 *
 * - `label: 'user'` (a person author) appears only in the renderer IPC handlers
 *   and the paired-person Annex routes, never in services agents, Actions or
 *   agent-calls reach.
 * - Those Annex routes require mTLS, and the client helpers that call them are
 *   used only by the renderer's annex-client IPC handlers, not by agent paths.
 * - The host's replica forwards carry no implicit person default.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MAIN = path.join(__dirname, '..');
// Normalize line endings: Windows checkouts use CRLF.
const text = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const read = (rel: string) => text(path.join(MAIN, rel));

function productionFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const PERSON_AUTHOR = /label:\s*'user'/;

describe('person authors only at person entry points (#3664)', () => {
  it('uses a person author only in renderer IPC handlers and paired-person Annex routes', () => {
    const files = productionFiles(MAIN)
      .filter((file) => PERSON_AUTHOR.test(text(file)))
      .map((file) => path.relative(MAIN, file).split(path.sep).join('/'))
      .sort();
    expect(files).toEqual(['ipc/group-project-handlers.ts', 'services/annex-server.ts']);
  });

  it('gives every Annex group-project write route that names a person mTLS, the paired-person transport', () => {
    const source = read('services/annex-server.ts');
    const handlers = [...source.matchAll(/async function (handleGroupProject\w+Route)\([^)]*\)[^{]*\{([\s\S]*?)\n\}\n/g)];
    const personRoutes = handlers.filter(([, , body]) => PERSON_AUTHOR.test(body));
    expect(personRoutes.length).toBeGreaterThanOrEqual(5);
    for (const [, name, body] of personRoutes) {
      expect({ name, mtls: /ctx\.requireMtls\(\)/.test(body) }).toEqual({ name, mtls: true });
    }
  });

  it('calls those routes only from the renderer annex-client IPC handlers, never from agent paths', () => {
    const client = read('services/annex-client.ts');
    const writers = [...client.matchAll(/export function (request(?:GroupProject|Bulletin)\w+)\(/g)].map((m) => m[1])
      .filter((name) => !/Get$|Digest$|TopicMessages$|AllMessages$|Roles$/.test(name));
    expect(writers.length).toBeGreaterThan(0);
    const users = productionFiles(MAIN)
      .filter((file) => !file.endsWith(path.join('services', 'annex-client.ts')))
      .filter((file) => {
        const source = text(file);
        return writers.some((name) => new RegExp(`\\b${name}\\b`).test(source));
      })
      .map((file) => path.relative(MAIN, file).split(path.sep).join('/'));
    expect(users).toEqual(['ipc/annex-client-handlers.ts']);
  });

  it('has no implicit person default on any host replica forward', () => {
    const host = read('services/group-project-host.ts');
    expect(host).not.toMatch(/options\.author\s*\?\?\s*\{\s*label:\s*'user'\s*\}/);
  });
});
