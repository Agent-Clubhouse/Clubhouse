import type { Configuration } from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import path from 'path';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

export const mainConfig: Configuration = {
  entry: './src/main/index.ts',
  module: {
    rules,
  },
  plugins: [
    ...plugins,
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'src/main/services/clubhouse-mcp/bridge/clubhouse-mcp-bridge.js'),
          to: 'bridge/clubhouse-mcp-bridge.js',
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
  },
  externals: {
    'node-pty': 'commonjs node-pty',
  },
};
