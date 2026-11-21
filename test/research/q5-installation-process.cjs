// Synthetic metadata process-exit fixture; no Electron/app/provider imports.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
};
const { openNoticeInstallation } = require(path.resolve('src/main/services/group-project-notice-ledger/installation.ts'));
const point = process.argv[3];
if (!['markerSynced', 'directoryCreated', 'envelopeSynced'].includes(point)) throw new Error('Invalid synthetic exit point');
openNoticeInstallation(process.argv[2], { testFailure: (stage) => { if (stage === point) process.exit(77); } })
  .catch((error) => { console.error(error); process.exitCode = 1; });
