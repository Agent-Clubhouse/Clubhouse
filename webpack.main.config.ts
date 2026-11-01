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
    },
  },
  externals: {
    'node-pty': 'commonjs node-pty',
  },
};
