#!/usr/bin/env bash
# Human-operated, unpackaged visual review only. No app/provider is launched by --prepare-only.
set -euo pipefail
cd "$(dirname "$0")/.."
expected="${1:-}"
mode="${2:---prepare-only}"
[[ "$expected" =~ ^[a-f0-9]{40}$ ]] || { echo 'Pass the exact reviewed 40-character source head.' >&2; exit 1; }
[[ "$mode" == --prepare-only || "$mode" == --launch || "$mode" == --launch-no-cli ]] || { echo 'Use --prepare-only, --launch, or --launch-no-cli.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo 'This review launcher is macOS only; production platform gates remain intact.' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$expected" ]] || { echo 'Source head changed; regenerate the pinned handoff.' >&2; exit 1; }
git diff --quiet HEAD -- || { echo 'Tracked source changed; stop and regenerate the handoff.' >&2; exit 1; }
[[ "$(node --version)" == v24.22.1 ]] || { echo 'Use the existing working Node 24.22.1 environment; do not repair system Node.' >&2; exit 1; }
export CLUBHOUSE_ADOPTION_REVIEW_ROOT="${CLUBHOUSE_ADOPTION_REVIEW_ROOT:-$(node -e 'const fs=require("fs"),os=require("os"),path=require("path"); process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(),"clubhouse-adoption-review-")))')}"
if [[ ! -f "$CLUBHOUSE_ADOPTION_REVIEW_ROOT/review-manifest.json" ]]; then
  CLUBHOUSE_PREPARE_ADOPTION_REVIEW=1 CLUBHOUSE_ADOPTION_REVIEW_HEAD="$expected" \
    npm test -- scripts/adoption-review-fixture.test.ts -t 'prepares the persistent visual fixture' --reporter=default
fi
export CLUBHOUSE_ADOPTION_REVIEW_HEAD="$expected"
# Reject reused/mismatched profiles before launch. Never point this path at ordinary app data.
node <<'NODE'
const fs = require('fs'); const path = require('path'); const os = require('os');
const root = fs.realpathSync(process.env.CLUBHOUSE_ADOPTION_REVIEW_ROOT);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'review-manifest.json'), 'utf8'));
if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith('clubhouse-adoption-review-')
  || manifest.root !== root || manifest.sourceHead !== process.env.CLUBHOUSE_ADOPTION_REVIEW_HEAD
  || manifest.profile !== path.join(root, 'profile') || manifest.binary !== path.join(root, 'capability-only-claude')) throw new Error('Review manifest/head/isolation mismatch');
console.log('Fixture root:', root); console.log('Project is already registered:', manifest.project);
console.log('review-agent: actual fake-capability preview/adopt/unassign, no start.');
console.log('seeded-receipts: synthetic presentation only, no process/publication/failure observed.');
NODE
export CLUBHOUSE_USER_DATA="$CLUBHOUSE_ADOPTION_REVIEW_ROOT/profile"
export CLUBHOUSE_DISABLE_AUTO_UPDATE=1
export CLUBHOUSE_TEST_STABLE_BUILD=1
export CLUBHOUSE_TEST_NO_MODEL_PROBES=1
export CLUBHOUSE_ADOPTION_REVIEW_MODE="$mode"
export CLUBHOUSE_TEST_CLI_BINARIES="$(node -e 'const path=require("path");process.stdout.write(JSON.stringify({"claude-code":path.join(process.env.CLUBHOUSE_ADOPTION_REVIEW_ROOT,process.env.CLUBHOUSE_ADOPTION_REVIEW_MODE === "--launch-no-cli" ? "nonexistent-claude" : "capability-only-claude"),"codex-cli":"/nonexistent/adoption-review-codex","copilot-cli":"/nonexistent/adoption-review-copilot"}))')"
printf 'Restart preserving this fixture: CLUBHOUSE_ADOPTION_REVIEW_ROOT=%q bash scripts/launch-adoption-review.sh %q --launch\n' "$CLUBHOUSE_ADOPTION_REVIEW_ROOT" "$expected"
printf 'No-CLI refusal review (fresh fixture preferred): CLUBHOUSE_ADOPTION_REVIEW_ROOT=%q bash scripts/launch-adoption-review.sh %q --launch-no-cli\n' "$CLUBHOUSE_ADOPTION_REVIEW_ROOT" "$expected"
if [[ "$mode" == --prepare-only ]]; then
  echo 'Prepared and validated only. No Electron, PTY, provider, or CUA launched.'
  exit 0
fi
# npm start generates the UNPACKAGED .webpack/main bundles. Package output lives under
# .webpack/<arch> and packaged apps ignore the protective test CLI/model-probe seams.
npm start -- -- --clubhouse-new-chrome --user-data-dir="$CLUBHOUSE_USER_DATA"
