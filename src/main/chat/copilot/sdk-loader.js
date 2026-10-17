// Plain JavaScript on purpose, like ../claude/sdk-loader.js: ts-loader compiles
// TypeScript with `module: commonjs`, which turns `import()` into `require()`
// and would inline the Copilot SDK into the main bundle. webpack parses this
// file's dynamic import natively, so the SDK becomes its own lazy chunk that
// is only evaluated when a chat session uses the copilot_sdk driver.
//
// What never reaches the bundle (docs/copilot-sdk-driver.md):
// - the per-platform runtime packages (`@github/copilot-sdk-<platform>`,
//   optionalDependencies, ~130 MB each): the driver always passes the user's
//   own `copilot` as RuntimeConnection.forStdio({ path }), and the SDK only
//   resolves its bundled runtime when no path is given;
// - koffi, the native FFI library behind the in-process runtime host: aliased
//   to an empty module in webpack.main.config.ts, since Clubhouse never uses
//   the in-process connection.

export function loadCopilotSdk() {
  return import(/* webpackChunkName: "copilot-sdk" */ '@github/copilot-sdk');
}
