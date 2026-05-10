import type { Configuration } from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

// Monaco editor ships its own CSS — use a simpler loader without PostCSS
rules.push({
  test: /\.css$/,
  include: /node_modules[/\\]monaco-editor/,
  use: [
    { loader: 'style-loader' },
    { loader: 'css-loader' },
  ],
});

// Application CSS with PostCSS (Tailwind, etc.)
rules.push({
  test: /\.css$/,
  exclude: /node_modules[/\\]monaco-editor/,
  use: [
    { loader: 'style-loader' },
    { loader: 'css-loader' },
    { loader: 'postcss-loader' },
  ],
});

export const rendererConfig: Configuration = {
  module: {
    rules,
  },
  plugins: [
    ...plugins,
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/renderer/shims', to: 'shims' },
      ],
    }),
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
    alias: {
      'monaco-editor': 'monaco-editor/esm/vs/editor/editor.api',
    },
  },
};
