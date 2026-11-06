#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
expected="${1:-}"
mode="${2:---prepare-only}"
[[ "$expected" =~ ^[a-f0-9]{40}$ ]] || { echo 'Pass exact reviewed 40-character source head.' >&2; exit 1; }
[[ "$mode" == --prepare-only || "$mode" == --launch ]] || { echo 'Use --prepare-only or --launch.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo 'This human review launcher is macOS only.' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$expected" ]] || { echo 'Source head changed; regenerate review handoff.' >&2; exit 1; }
git diff --quiet HEAD -- || { echo 'Tracked source changed; regenerate review handoff.' >&2; exit 1; }
export CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT="${CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT:-$(node -e 'const fs=require("fs"),os=require("os"),path=require("path");process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(),"clubhouse-skill-library-review-")))')}"
if [[ ! -f "$CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT/review-manifest.json" ]]; then
  CLUBHOUSE_PREPARE_SKILL_LIBRARY_REVIEW=1 CLUBHOUSE_SKILL_LIBRARY_REVIEW_HEAD="$expected" \
    npm test -- scripts/skill-library-review-fixture.test.ts -t 'prepares persistent skill library visual fixture' --reporter=default
fi
export CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT="$(node -e 'process.stdout.write(require("fs").realpathSync(process.env.CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT))')"
export CLUBHOUSE_SKILL_LIBRARY_REVIEW_HEAD="$expected"
export HOME="$CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT/home"
export USERPROFILE="$HOME"
export CLUBHOUSE_USER_DATA="$CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT/profile"
node <<'NODE'
const fs=require('fs'),path=require('path'),os=require('os');
const root=fs.realpathSync(process.env.CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT);
const m=JSON.parse(fs.readFileSync(path.join(root,'review-manifest.json'),'utf8'));
if(path.dirname(root)!==fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith('clubhouse-skill-library-review-')
 || m.root!==root || m.sourceHead!==process.env.CLUBHOUSE_SKILL_LIBRARY_REVIEW_HEAD || m.profile!==path.join(root,'profile') || m.home!==path.join(root,'home')
 || m.catalogDir!==path.join(m.profile,'.clubhouse-dev','asset-catalog')) throw new Error('Review head/profile mismatch');
for(const directory of [root,m.home,m.profile]) {
 const stat=fs.lstatSync(directory);
 if(!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory)!==directory || (stat.mode&0o777)!==0o700) throw new Error('Private fixture directory required');
}
if(process.env.HOME!==m.home || process.env.USERPROFILE!==m.home || process.env.CLUBHOUSE_USER_DATA!==m.profile) throw new Error('Review environment mismatch');
for(const id of ['claude-code','codex-cli','copilot-cli']) if(fs.existsSync(path.join(root,'nonexistent-'+id))) throw new Error('Refusing an existing CLI override path');
console.log('Fixture:',root); console.log('Registered contexts:',m.projects.map(p=>p.name).join(', '));
console.log('Validated destinations:',JSON.stringify({HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,CLUBHOUSE_USER_DATA:process.env.CLUBHOUSE_USER_DATA,userDataArgument:'--user-data-dir='+m.profile}));
NODE
export CLUBHOUSE_DISABLE_AUTO_UPDATE=1 CLUBHOUSE_TEST_STABLE_BUILD=1 CLUBHOUSE_TEST_NO_MODEL_PROBES=1
export CLUBHOUSE_TEST_CLI_BINARIES="$(node -e 'const p=require("path"),root=process.env.CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT;process.stdout.write(JSON.stringify(Object.fromEntries(["claude-code","codex-cli","copilot-cli"].map(id=>[id,p.join(root,"nonexistent-"+id)]))))')"
printf 'Reuse fixture: CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT=%q bash scripts/launch-skill-library-review.sh %q --launch\n' "$CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT" "$expected"
if [[ "$mode" == --prepare-only ]]; then echo 'Prepared only. No app, provider, CLI or CUA launched.'; exit 0; fi
# Unpackaged build only: packaged artifacts ignore the protective CLI/model seams.
npm start -- -- --clubhouse-new-chrome --user-data-dir="$CLUBHOUSE_USER_DATA"
