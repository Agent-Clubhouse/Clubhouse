// Plain JavaScript on purpose, like src/main/telemetry/lazy-chunks.js.
// ts-loader compiles our TypeScript with `module: commonjs`, which rewrites
// `import()` into `require()` and would inline the Claude Agent SDK (~1.3 MB
// minified) into the main bundle. webpack parses this file's dynamic import
// natively, so the SDK becomes its own lazy chunk that is only evaluated when
// a chat session actually uses the SDK transport.
//
// The SDK's per-platform CLI binaries (optionalDependencies, ~250 MB each) are
// never reached: the transport always sets `pathToClaudeCodeExecutable` to the
// user's own `claude`, and the SDK only resolves its bundled binary when that
// option is missing.

export function loadClaudeAgentSdk() {
  return import(/* webpackChunkName: "claude-agent-sdk" */ '@anthropic-ai/claude-agent-sdk');
}
