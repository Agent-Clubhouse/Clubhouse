#!/usr/bin/env node
// REPORT ONLY. This tool never executes tests or changes CI outputs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createHash } from 'node:crypto';

export const COHORT = Object.freeze({
  'src/main/navigation-guard.test.ts': ['vitest', './navigation-guard'],
  'src/main/build-info.test.ts': ['vitest', './build-info'],
  'src/renderer/utils/format.test.ts': ['vitest', './format'],
});
const LEAF = 'src/renderer/utils/format.ts';
const SENTINELS = ['src/main/services/dispatcher/dispatcher-copy.test.ts', 'src/main/ipc/index.integration.test.ts', 'src/main/util/windows-pty.test.ts', 'src/main/services/pty-manager.test.ts', 'src/main/services/file-watch-service.test.ts', 'src/main/services/auto-update-apply.test.ts', 'src/main/services/auto-update-apply-windows.test.ts'];
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.test\.[jt]sx?$/;
const INVARIANTS = ['full existing CI remains authoritative', 'Windows path validation', 'global setup and project setup', 'typecheck/lint/coverage and architecture ratchets', 'no hosted activation or workflow changes'];
const sorted = (values) => [...values].sort();
const git = (repo, args, input) => execFileSync('git', args, { cwd: repo, input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });

function commit(repo, rev) {
  if (!rev || rev.startsWith('-')) throw new Error('invalid revision');
  return git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]).toString().trim();
}

/** Read immutable blobs in one batch; never check out or execute historical code. */
export function readSnapshot(repo, sha, contents = true) {
  const entries = git(repo, ['ls-tree', '-rz', '--full-tree', sha]).toString().split('\0').filter(Boolean);
  const files = new Map();
  const blobs = [];
  for (const entry of entries) {
    const [, mode, type, oid, name] = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry) ?? [];
    if (!name) throw new Error('invalid tree entry');
    if (type !== 'blob' || mode === '120000') throw new Error(`unsupported tree boundary: ${name}`);
    files.set(name, null);
    if (contents && CODE.test(name)) blobs.push([name, oid]);
  }
  if (!blobs.length) return files;
  const output = git(repo, ['cat-file', '--batch'], blobs.map(([, oid]) => oid).join('\n') + '\n');
  let offset = 0;
  for (const [name] of blobs) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString();
    const size = Number(header.split(' ')[2]);
    if (!/^[a-f0-9]+ blob \d+$/.test(header) || !Number.isSafeInteger(size)) throw new Error('missing historical blob');
    files.set(name, output.subarray(end + 1, end + 1 + size).toString());
    offset = end + size + 2;
  }
  return files;
}

/** AST-derived static imports, exports, import types, mocks, and opaque loader boundaries. */
export function parseModule(name, text) {
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const declarations = [];
  const hazards = [];
  if (ast.parseDiagnostics.length) hazards.push('parse-error');
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) { imports.push(node.moduleSpecifier.text); declarations.push(node.getText(ast)); }
      else hazards.push('nonliteral-static-import');
    }
    if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)) hazards.push('import-type-or-equals');
    if (ts.isCallExpression(node)) {
      const expr = node.expression.getText(ast);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || /(?:^|\.)(?:require|mock|doMock|unmock|resolve|glob|globEager|readFileSync|readFile|readdirSync|readdir|createRequire)$/.test(expr)) hazards.push(`opaque-loader:${expr}`);
    }
    if (ts.isIdentifier(node) && /^(?:eval|Function|process|globalThis|window|document|Electron|electron)$/.test(node.text)) hazards.push(`runtime-boundary:${node.text}`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { imports: sorted(imports), declarations: sorted(declarations), hazards: sorted(new Set(hazards)) };
}

function resolveImport(from, specifier, files) {
  if (!specifier.startsWith('.')) return null; // Bare/alias imports retained in graph signature.
  const stem = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [stem, ...(stem.endsWith('.js') ? [stem.slice(0, -3) + '.ts', stem.slice(0, -3) + '.tsx'] : []), ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js'].map((ext) => stem + ext)];
  const matches = candidates.filter((p) => files.has(p));
  return matches.length === 1 ? matches[0] : undefined;
}

export function buildGraph(files) {
  const modules = new Map();
  const reverse = new Map();
  for (const [name, content] of files) {
    if (!CODE.test(name) || typeof content !== 'string') continue;
    const parsed = parseModule(name, content);
    const edges = [];
    for (const specifier of parsed.imports) {
      const target = resolveImport(name, specifier, files);
      if (target === undefined) parsed.hazards.push(`unresolved:${specifier}`);
      if (target) {
        edges.push(target);
        if (!reverse.has(target)) reverse.set(target, new Set());
        reverse.get(target).add(name);
      }
    }
    modules.set(name, { ...parsed, edges: sorted(edges) });
  }
  return { modules, reverse };
}

export function consumers(graph, file) {
  const seen = new Set();
  const pending = [...(graph.reverse.get(file) ?? [])];
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    pending.push(...(graph.reverse.get(name) ?? []));
  }
  return sorted(seen);
}

/** Enforced capability boundary, intentionally smaller than arbitrary pure TypeScript. */
export function pureFormatter(text) {
  const ast = ts.createSourceFile(LEAF, text, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length || ast.statements.length !== 1) return false;
  const fn = ast.statements[0];
  if (!ts.isFunctionDeclaration(fn) || fn.name?.text !== 'formatDuration' || fn.parameters.length !== 1 || fn.parameters[0].name.getText(ast) !== 'ms' || fn.parameters[0].type?.kind !== ts.SyntaxKind.NumberKeyword || fn.type?.kind !== ts.SyntaxKind.StringKeyword || fn.asteriskToken || fn.parameters[0].questionToken || fn.parameters[0].initializer || fn.parameters[0].dotDotDotToken || fn.typeParameters || fn.modifiers?.length !== 1 || fn.modifiers[0].kind !== ts.SyntaxKind.ExportKeyword || !fn.body) return false;
  const locals = new Set(['ms']);
  let valid = true;
  const operators = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);
  function expression(n) {
    if (ts.isIdentifier(n)) return locals.has(n.text);
    if (ts.isNumericLiteral(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
    if (ts.isParenthesizedExpression(n)) return expression(n.expression);
    if (ts.isBinaryExpression(n)) return operators.has(n.operatorToken.kind) && expression(n.left) && expression(n.right);
    if (ts.isConditionalExpression(n)) return expression(n.condition) && expression(n.whenTrue) && expression(n.whenFalse);
    if (ts.isTemplateExpression(n)) return n.templateSpans.every((span) => expression(span.expression));
    if (ts.isCallExpression(n)) return !n.typeArguments && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(ast) === 'Math' && ['floor', 'round'].includes(n.expression.name.text) && n.arguments.length === 1 && expression(n.arguments[0]);
    return false;
  }
  function statement(n) {
    if (ts.isBlock(n)) return n.statements.every(statement);
    if (ts.isReturnStatement(n)) return !!n.expression && expression(n.expression);
    if (ts.isIfStatement(n)) return expression(n.expression) && statement(n.thenStatement) && (!n.elseStatement || statement(n.elseStatement));
    if (ts.isVariableStatement(n) && n.declarationList.flags === ts.NodeFlags.Const) return n.declarationList.declarations.every((d) => {
      if (!ts.isIdentifier(d.name) || locals.has(d.name.text) || !d.initializer || !expression(d.initializer)) return false;
      locals.add(d.name.text); return true;
    });
    return false;
  }
  valid = statement(fn.body);
  return valid;
}

// Only literal expectation/input changes in existing expect(...) expression statements.
// Changing test registration, mocks, imports, skip/only, hooks or arbitrary effects fails.
export function assertionShape(name, text) {
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) return null;
  function shape(n, assertion = false) {
    const inAssertion = assertion || (ts.isExpressionStatement(n) && /^expect\(/.test(n.getText(ast)));
    if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.kind, inAssertion ? '<literal>' : n.text];
    const children = n.getChildren(ast);
    return [n.kind, children.length ? children.map((child) => shape(child, inAssertion)) : n.getText(ast)];
  }
  return JSON.stringify(shape(ast));
}

function identities(result) {
  const projects = {};
  for (const file of result.tests) {
    const project = file.startsWith('src/renderer/') ? 'renderer' : file.startsWith('src/shared/') ? 'shared' : file.startsWith('src/preload/') ? 'preload' : file.startsWith('test/') ? 'integration' : 'main';
    (projects[project] ??= []).push(file);
  }
  result.projectTests = projects; // Identical project/file identities on every reported platform.
  return result;
}

/** Pure decision API: complete path inventory and all code contents required. */
export function decide(baseFiles, headFiles, changed, metadata = {}) {
  const tests = sorted([...headFiles.keys()].filter((name) => TEST.test(name)));
  const result = { schemaVersion: 1, reportOnly: true, base: metadata.base ?? null, head: metadata.head ?? null,
    mode: 'full', fullSuiteRequired: true, changed: sorted(new Set(changed)), tests, reasons: [], platforms: ['linux', 'windows'], invariants: INVARIANTS,
    changedStatuses: sorted(new Set(changed)).map((file) => ({ file, status: !baseFiles.has(file) ? 'A' : !headFiles.has(file) ? 'D' : 'M' })),
    evidence: [], parserVersion: ts.version, contractSha256: createHash('sha256').update(JSON.stringify({ COHORT, LEAF, SENTINELS, INVARIANTS })).digest('hex') };
  const full = (reason) => { result.reasons.push(reason); return identities(result); };
  if (metadata.inputError) return full(`input-uncertain: ${metadata.inputError}`);
  if (!changed.length) return full('empty-diff: retain full suite');
  const outside = changed.filter((name) => name !== LEAF && !Object.hasOwn(COHORT, name));
  if (outside.length) return full(`outside-reviewed-cohort (production/config/fixture/shared/preload/native/platform boundaries): ${sorted(outside).join(', ')}`);
  const before = buildGraph(baseFiles), after = buildGraph(headFiles);
  const production = changed.includes(LEAF);
  for (const name of sorted(changed)) {
    const old = before.modules.get(name), next = after.modules.get(name);
    if (!old || !next) return full(`added/deleted/unknown module: ${name}`);
    if (JSON.stringify(old) !== JSON.stringify(next)) return full(`changed import graph or runtime boundary: ${name}`);
    if (name === LEAF) {
      if (!pureFormatter(baseFiles.get(name)) || !pureFormatter(headFiles.get(name))) return full(`formatter capability/signature boundary: ${name}`);
    } else {
      if (JSON.stringify(next.imports) !== JSON.stringify(sorted(COHORT[name]))) return full(`import contract mismatch: ${name}`);
      if (old.hazards.length || next.hazards.length) return full(`dynamic/config/platform boundary: ${name}`);
      if (assertionShape(name, baseFiles.get(name)) !== assertionShape(name, headFiles.get(name))) return full(`not an assertion-literal-only change: ${name}`);
    }
    const users = sorted(new Set([...consumers(before, name), ...consumers(after, name)]));
    if (name !== LEAF && users.length) return full(`reverse consumers of test module: ${name}: ${users.join(', ')}`);
    if (name === LEAF && users.some((file) => !file.startsWith('src/renderer/'))) return full(`cross-feature formatter consumers: ${users.join(', ')}`);
    for (const dependency of next.edges) {
      const node = after.modules.get(dependency);
      if (!node || node.imports.length || node.hazards.length) return full(`dependency is not a dependency-free leaf: ${dependency}`);
    }
    result.evidence.push({ file: name, imports: next.imports, dependencies: next.edges, reverseConsumers: users });
  }
  if (production) {
    if (SENTINELS.some((name) => !headFiles.has(name))) return full('missing mandatory sentinel');
    const retained = new Set(tests.filter((name) => !name.startsWith('src/main/') && !name.startsWith('scripts/')));
    SENTINELS.forEach((name) => retained.add(name));
    // Unknown source-read / dynamic boundaries in main and scripts are conservatively
    // retained, together with every static reverse test consumer of those boundaries.
    for (const graph of [before, after]) for (const [name, node] of graph.modules) {
      if (node.hazards.length || node.imports.some((specifier) => /^(node:)?(?:fs|path|module|child_process)(?:\/|$)/.test(specifier))) {
        for (const candidate of [name, ...consumers(graph, name)]) if (TEST.test(candidate) && headFiles.has(candidate)) retained.add(candidate);
      }
    }
    for (const name of consumers(after, LEAF)) if (TEST.test(name)) retained.add(name);
    result.tests = sorted(retained);
    result.reasons.push('capability-guarded duration formatter; entire renderer/shared/preload/integration plus scanner/dynamic/OS/IPC sentinels retained on both platforms');
  } else {
    result.tests = sorted(new Set(changed));
    result.reasons.push('assertion-literal-only edits; identical static import contracts; dependency-free leaves; no reverse test consumers');
  }
  result.mode = 'selected'; result.fullSuiteRequired = false;
  return identities(result);
}

export function report({ repo = process.cwd(), base, head }) {
  let baseFiles = new Map(), headFiles = new Map(), changed = [], baseSha = null, headSha = null;
  try {
    baseSha = commit(repo, base);

    if (head === 'WORKTREE') {
      headSha = 'WORKTREE';
      if (git(repo, ['ls-files', '--unmerged', '-z']).length) throw new Error('unmerged index');
      if (git(repo, ['ls-files', '-v', '-z']).toString().split('\0').some((entry) => /^[a-zS]/.test(entry))) throw new Error('assume-unchanged/skip-worktree flags obscure working tree');
      headFiles = readSnapshot(repo, commit(repo, 'HEAD'));
      const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
      changed = git(repo, ['diff', '--no-renames', '--name-only', '-z', baseSha, '--']).toString().split('\0').filter(Boolean);
      if (untracked.length) throw new Error(`untracked paths: ${untracked.join(', ')}`);
      for (const name of headFiles.keys()) {
        const target = path.join(repo, name);
        if (!fs.existsSync(target)) headFiles.delete(name);
        else if (CODE.test(name)) {
          if (!fs.lstatSync(target).isFile()) throw new Error(`nonregular working path: ${name}`);
          headFiles.set(name, fs.readFileSync(target, 'utf8'));
        }
      }
      // Include staged additions; unknown files still fan out.
      for (const name of changed) if (!headFiles.has(name) && fs.existsSync(path.join(repo, name))) headFiles.set(name, CODE.test(name) ? fs.readFileSync(path.join(repo, name), 'utf8') : null);
    } else {
      headSha = commit(repo, head);

      // Direct immutable tree comparison, deliberately NOT merge-base semantics.
      changed = git(repo, ['diff', '--no-renames', '--name-only', '-z', baseSha, headSha, '--']).toString().split('\0').filter(Boolean);
    }
    if (head !== 'WORKTREE') {
      const eligible = changed.length > 0 && changed.every((name) => name === LEAF || Object.hasOwn(COHORT, name));
      baseFiles = readSnapshot(repo, baseSha, eligible);
      headFiles = readSnapshot(repo, headSha, eligible);
    } else baseFiles = readSnapshot(repo, baseSha);
    const result = decide(baseFiles, headFiles, changed, { base: baseSha, head: headSha });
    result.selectorSha256 = createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
    result.configObjects = {};
    const configs = ['package.json', 'package-lock.json', 'vitest.config.ts', 'tsconfig.json', 'test/global-setup.ts', 'test/setup-renderer.ts', 'test/standard-runtime-boundary.ts'];
    for (const [label, sha] of [['base', baseSha], ['head', headSha]]) {
      if (sha !== 'WORKTREE') result.configObjects[label] = git(repo, ['ls-tree', sha, '--', ...configs]).toString().trim().split('\n').filter(Boolean);
    }
    return result;
  } catch (error) {
    return decide(baseFiles, headFiles, changed, { base: baseSha, head: headSha, inputError: error.message });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--base', '--head', '--repo'].includes(args[i]) || !args[i + 1] || options[args[i].slice(2)]) {
      console.error('Usage: node scripts/ci/affected-shadow.mjs --base REV --head REV|WORKTREE [--repo DIR]');
      process.exit(2);
    }
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.base || !options.head) { console.error('--base and --head are required'); process.exit(2); }
  console.log(JSON.stringify(report(options), null, 2));
}
