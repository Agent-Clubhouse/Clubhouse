// Plain JavaScript on purpose. ts-loader compiles our TypeScript with
// `module: commonjs`, which rewrites `import()` into `require()` and would
// inline the OpenTelemetry SDK into the main bundle. webpack parses this
// file's dynamic imports natively, so each target becomes its own lazy chunk
// that is never evaluated unless telemetry is enabled (spec §6.3).

export function loadSdk() {
  return import(/* webpackChunkName: "telemetry-sdk" */ './sdk');
}

export function loadAzureDestination() {
  return import(/* webpackChunkName: "telemetry-azure" */ './destinations/azure');
}

export function loadOtlpDestination() {
  return import(/* webpackChunkName: "telemetry-otlp" */ './destinations/otlp');
}
