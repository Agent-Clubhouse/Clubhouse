import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';
import ts from 'typescript';

// Regression guard for the v0.40+ plugin-launch failure:
//   "Cannot find module 'clubhouse-plugin://plugin/v…/…/main.js'"
//
// Cause: a dynamic `import()` written in TypeScript and compiled under
// tsconfig's `module: "commonjs"` is downleveled to `require()`, which dies on
// the custom scheme and never reaches the protocol handler. The fix moves the
// real `import()` into a plain `.js` file (native-import.js) that ts-loader does
// not transform. These tests fail if anyone reverts that.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), 'utf-8');

describe('native dynamic import isolation', () => {
  // Read the project's real module setting so the test tracks tsconfig.
  const tsconfig = JSON.parse(read('../../../tsconfig.json'));
  const projectModule: string = tsconfig.compilerOptions.module;

  it('documents the hazard: TS downlevels import() to require() under the project module setting', () => {
    const src = 'export const f = (s: string) => import(/* webpackIgnore: true */ s);';

    const cjs = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    // The bug, reproduced: import() is gone, replaced by a require() call.
    expect(cjs).toMatch(/require\(/);
    expect(cjs).not.toMatch(/\bimport\(/);

    // Sanity: the project is configured with the module kind that triggers this.
    expect(projectModule.toLowerCase()).toBe('commonjs');

    // Contrast: an ESM target preserves the native import().
    const esm = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    expect(esm).toMatch(/\bimport\(/);
    expect(esm).not.toMatch(/require\(/);
  });

  it('keeps the real dynamic import in a plain .js module webpack does not transform', () => {
    // The file must be .js (ts-loader rule is /\.tsx?$/), so webpack — not TS —
    // parses it and honors the webpackIgnore magic comment, leaving a native
    // import(). A .ts here would re-introduce the require() downlevel.
    const js = read('./native-import.js');
    expect(js).toMatch(/\bimport\(/);
    expect(js).toMatch(/webpackIgnore/);
    // CSP forbids unsafe-eval in production — the old indirect-eval shim is gone.
    // Check executable code only (the header comment discusses these by name).
    const jsCode = js
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(jsCode).not.toMatch(/new Function|\beval\b/);
  });

  it('routes plugin module loading through the .js helper, never a TS-compiled import()', () => {
    const loader = read('./dynamic-import.ts');
    // Delegates to the native helper…
    expect(loader).toMatch(/from '\.\/native-import'/);
    expect(loader).toMatch(/nativeDynamicImport/);
    // …and contains no bare dynamic import() call of its own (comments aside).
    const codeOnly = loader
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/[^\n]*/g, ''); // line comments
    expect(codeOnly).not.toMatch(/\bimport\s*\(/);
  });
});
