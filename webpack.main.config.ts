import type { Configuration } from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import { DefinePlugin } from 'webpack';
import path from 'path';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';
import { resolveBuildSha } from './scripts/build-sha';

export const mainConfig: Configuration = {
  entry: './src/main/index.ts',
  module: {
    rules,
  },
  plugins: [
    ...plugins,
    // The build commit for feedback reports (src/main/build-info.ts, #2098).
    new DefinePlugin({ __CLUBHOUSE_BUILD_SHA__: JSON.stringify(resolveBuildSha()) }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'src/main/services/clubhouse-mcp/bridge/clubhouse-mcp-bridge.js'),
          to: 'bridge/clubhouse-mcp-bridge.js',
        },
        {
          from: path.resolve(__dirname, 'src/main/services/cli/clubhouse-cli.js'),
          to: 'cli/clubhouse-cli.js',
        },
        {
          from: path.resolve(__dirname, 'assets/icon.png'),
          to: 'icon.png',
        },
      ],
    }),
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
    alias: {
      // Native FFI for the Copilot SDK's in-process transport, which we don't use.
      // Left alone, it emits koffi.node into the bundle (docs/copilot-sdk-driver.md).
      koffi: false,
      // v2 defaults to native hosting. This app explicitly attaches over TCP;
      // exclude the unused FFI host implementation as well as its dependency.
      [path.resolve(__dirname, 'node_modules/@microsoft/copilot-sdk/dist/ffiRuntimeHost.js')]: false,
    },
  },
  externals: [
    { 'node-pty': 'commonjs node-pty' },
    // Runtime artifacts are resolved only by SDK-owned hosts, never by our TCP
    // attachment. Keep both package generations out of the app's bundle.
    ({ request }, callback) => {
      if (request && /^@(?:microsoft|github)\/copilot-sdk-/.test(request)) return callback(null, `commonjs ${request}`);
      callback();
    },
  ],
};
