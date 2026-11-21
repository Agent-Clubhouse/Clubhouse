// Source-only inventory. No production module is imported or invoked.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const ts = require('typescript');
const root = __dirname;
const repo = path.resolve(root, '../../..');
const base = '77fa095320f2184ebf8870a5251ad0fd26a46501';
if (cp.execFileSync('git', ['status', '--porcelain=v1', '--', 'src'], { cwd: repo, encoding: 'utf8' }).trim()) throw Error('Source worktree is dirty');
const names = cp.execFileSync('rg', ['--files', 'src/main', '-g', '*.ts', '-g', '!*.test.ts', '-g', '!*.qa.ts'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').sort();
const calls = [], directReplaceImports = [], annexWriteReferences = [];
for (const file of names) {
  const body = fs.readFileSync(path.join(repo, file), 'utf8');
  const tree = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const annexNamespaces = new Set(), annexFunctions = new Map();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !/(?:^|\/)annex-settings$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) annexNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      const original = (item.propertyName ?? item.name).text;
      if (['saveSettings', 'updateSettings'].includes(original)) annexFunctions.set(item.name.text, original);
    }
  }
  function writeReference(node) {
    let writer;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && annexNamespaces.has(node.expression.text) && ['saveSettings', 'updateSettings'].includes(node.name.text)) writer = node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
      && annexNamespaces.has(node.expression.text) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
      && ['saveSettings', 'updateSettings'].includes(node.argumentExpression.text)) writer = node.argumentExpression.text;
    if (ts.isIdentifier(node) && annexFunctions.has(node.text)
      && !(ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent))) writer = annexFunctions.get(node.text);
    if (writer) annexWriteReferences.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      writer, directCall: !!node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node });
  }
  function walk(node) {
    writeReference(node);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ['createSettingsStore', 'replaceFile'].includes(node.expression.text)) {
      const position = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      calls.push({ callee: node.expression.text, file, line: position.line + 1 });
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && /(?:^|\/)settings-store$/.test(node.moduleSpecifier.text)
      && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const item of node.importClause.namedBindings.elements) {
        if ((item.propertyName ?? item.name).text === 'replaceFile') directReplaceImports.push(file);
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(tree);
}
const selected = [...new Set(['src/main/services/settings-store.ts', 'src/main/services/annex-settings.ts',
  'src/main/ipc/annex-handlers.ts', 'src/main/services/clubhouse-mcp/tools/annex-network-tools.ts',
  'src/main/telemetry/persist.ts', 'src/shared/telemetry/persist-signals.ts',
  'src/renderer/stores/annexStore.ts', 'src/renderer/features/settings/AnnexNetworkSettingsView.tsx',
  'src/renderer/features/settings/AnnexIdentitySection.tsx', 'src/renderer/features/command-palette/use-command-source.ts',
  'src/preload/annex.ts', ...calls.map(item => item.file), ...directReplaceImports])].sort();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceSHA256 = {};
for (const file of selected) {
  const actual = fs.readFileSync(path.join(repo, file));
  const frozen = cp.execFileSync('git', ['show', base + ':' + file], { cwd: repo });
  if (!actual.equals(frozen)) throw Error('Source binding changed: ' + file);
  sourceSHA256[file] = sha256(actual);
}
const record = { status: 'READ-ONLY SOURCE INVENTORY, not implementation/test/compatibility proof', base,
  headAtCollection: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  collectedAt: new Date().toISOString(), cpu: os.cpus().length, load: os.loadavg(),
  scannedProductionTsFiles: names.length,
  createSettingsStoreCallSites: calls.filter(item => item.callee === 'createSettingsStore'),
  replaceFileCallSites: calls.filter(item => item.callee === 'replaceFile'),
  directReplaceImports: [...new Set(directReplaceImports)].sort(), annexWriteReferences, sourceSHA256,
  collectorSHA256: sha256(fs.readFileSync(__filename)) };
fs.writeFileSync(path.join(root, 'callers.json'), JSON.stringify(record, null, 2) + '\n');
for (const [file, pattern, scope] of [
  ['annex-main-writers.txt', 'annexSettings\\.(saveSettings|updateSettings)|from .+annex-settings', ['src/main']],
  ['local-save-producers.txt', 'saveSettings|onSave', ['src/renderer/stores/annexStore.ts', 'src/renderer/features/settings/AnnexNetworkSettingsView.tsx', 'src/renderer/features/settings/AnnexIdentitySection.tsx', 'src/renderer/features/command-palette/use-command-source.ts', 'src/preload/annex.ts']],
]) {
  const result = cp.spawnSync('rg', ['-n', pattern, ...scope, '--glob', '!*.test.ts', '--glob', '!*.qa.ts'], { cwd: repo, encoding: 'utf8' });
  fs.writeFileSync(path.join(root, file + '.json'), JSON.stringify({ argv: ['rg', '-n', pattern, ...scope, '--glob', '!*.test.ts', '--glob', '!*.qa.ts'], actualExit: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2) + '\n');
  if (result.status !== 0) throw Error('Inventory search failed: ' + file);
}
console.log(JSON.stringify({ createSettingsStoreCallSites: record.createSettingsStoreCallSites.length,
  replaceFileCallSites: record.replaceFileCallSites.length, directReplaceImporters: record.directReplaceImports.length,
  status: record.status }));
