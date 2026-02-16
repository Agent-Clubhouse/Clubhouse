import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');

rules.push({
  test: /\.css$/,
  use: [
    { loader: 'style-loader' },
    { loader: 'css-loader' },
    { loader: 'postcss-loader' },
  ],
});

plugins.push(
  new MonacoWebpackPlugin({
    languages: [
      'typescript',
      'javascript',
      'css',
      'html',
      'json',
      'markdown',
      'python',
      'rust',
      'go',
      'java',
      'sql',
      'yaml',
      'xml',
      'shell',
      'diff',
    ],
  })
);

export const rendererConfig: Configuration = {
  module: {
    rules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
