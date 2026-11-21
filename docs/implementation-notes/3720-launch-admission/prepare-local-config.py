"""Generate task-local Vitest config/cache; never modifies node_modules."""
from pathlib import Path
repo=Path(__file__).resolve().parents[3]
config=repo/'.cache/3720-launch/vitest.config.ts'
config.parent.mkdir(parents=True,exist_ok=True)
s=(repo/'vitest.config.ts').read_text().replace('__dirname','proofRoot')
s=s.replace("import * as fs from 'fs';", "import * as fs from 'fs';\nconst proofRoot = path.resolve(import.meta.dirname, '../..');")
s=s.replace('  mockReset: true,','  cache: false,\n  mockReset: true,')
s=s.replace('export default defineConfig({','export default defineConfig({\n  root: proofRoot,')
s=s.replace('plugins: [rawMarkdown()],', "plugins: [rawMarkdown()],\n    cacheDir: path.join(import.meta.dirname, 'vite-cache'),")
config.write_text(s)
print(config.relative_to(repo))
