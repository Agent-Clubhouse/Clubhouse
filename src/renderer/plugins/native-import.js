// Native ESM dynamic import, deliberately isolated in a plain `.js` module.
//
// WHY THIS IS NOT A `.ts` FILE:
// tsconfig.json sets `module: "commonjs"`, and the ts-loader webpack rule
// (`test: /\.tsx?$/`) runs over every `.ts`/`.tsx` source. Under commonjs,
// TypeScript *downlevels* a dynamic `import(x)` into
// `Promise.resolve(x).then(s => require(s))` — and it strips the
// `/* webpackIgnore */` magic comment in the process. The result is a webpack
// `require()` of a runtime string, which throws
// `Cannot find module 'clubhouse-plugin://…'` at load time and never performs a
// real ESM fetch (so the main-process protocol handler is never reached). That
// is exactly the regression that broke community-plugin loading from v0.40.
//
// Because the ts-loader rule only matches `.tsx?`, a `.js` file is parsed by
// webpack directly: webpack honors the `webpackIgnore` magic comment and emits
// a genuine native `import()`. This is CSP-safe (no `eval`/`new Function`, which
// the production CSP forbids after the nonce migration) and keeps the
// `clubhouse-plugin:` URL a real module request that Chromium dispatches to the
// protocol handler.
//
// Keep this file tiny and `.js` — moving the `import()` back into TypeScript
// re-introduces the downlevel bug. native-import.test.ts guards against that.
export function nativeDynamicImport(specifier) {
  return import(/* webpackIgnore: true */ specifier);
}
