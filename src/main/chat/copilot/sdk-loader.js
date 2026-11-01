// Plain JavaScript on purpose, like ../claude/sdk-loader.js: ts-loader would
// rewrite `import()` into `require()` and inline the SDK into the main bundle.
// webpack parses this file's dynamic import natively, so the SDK becomes its own
// lazy chunk that is only evaluated when a chat session uses it.
//
// Two things in the SDK's dependency tree never reach the bundle:
//  - `koffi`, the native FFI library for the experimental in-process transport,
//    which we don't use. webpack.main.config.ts aliases it away.
//  - the bundled CLI (@github/copilot-sdk-<platform>, optional, ~159 MB), which
//    the SDK only resolves when it isn't given a path to the user's `copilot`.

export function loadCopilotSdk() {
  return import(/* webpackChunkName: "github-copilot-sdk" */ '@github/copilot-sdk');
}
