// PILOT, never ships. The renderer's real loaders with the harness as entry. Run: node scripts/pilot/webpack.pilot.cjs [out dir]
// (This repo has no webpack-cli, so `npx webpack` sits at an install prompt.)
// Mirrors webpack.rules.ts and webpack.renderer.config.ts, which need a TS loader this repo doesn't have outside forge.
const path = require('path');
const root = path.resolve(__dirname, '../..');
const rules = [
  { test: /\.tsx?$/, exclude: /(node_modules|\.webpack)/, use: { loader: 'ts-loader', options: { transpileOnly: true } } },
  { test: /\.css$/, use: ['style-loader', 'css-loader', 'postcss-loader'] },
  { test: /\.ttf$/, type: 'asset/resource' },
  { test: /\.md$/, type: 'asset/source' },
];
const config = (env = {}) => ({
  mode: 'production',
  target: 'web',
  context: root,
  devtool: false,
  performance: false,
  entry: env.entry ? path.resolve(root, env.entry) : path.join(root, 'src/renderer/features/feedback/pilot-harness-entry.tsx'),
  output: { path: env.out || '/tmp/editor-pilot-harness', filename: 'harness.js', clean: true },
  module: { rules },
  resolve: { extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'], alias: { 'monaco-editor': path.join(root, 'src/__mocks__/monaco-editor.ts') } },
  ...(env.nominify ? { optimization: { minimize: false } } : {}),
});

if (require.main === module) {
  const webpack = require('webpack');
  webpack(config({ out: process.argv[2] }), (err, stats) => {
    if (err) throw err;
    console.log(stats.toString({ all: false, assets: true, errors: true, warnings: true, timings: true }));
    process.exit(stats.hasErrors() ? 1 : 0);
  });
}
module.exports = config;
