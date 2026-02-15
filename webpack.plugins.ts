import type IForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';
import MonacoWebpackPlugin from 'monaco-editor-webpack-plugin';

const ForkTsCheckerWebpackPlugin: typeof IForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');

export const plugins = [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
  }),
  new MonacoWebpackPlugin({
    languages: [
      'typescript', 'javascript', 'markdown', 'json', 'html', 'css',
      'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'csharp',
      'yaml', 'xml', 'shell', 'sql', 'cpp',
    ],
    features: [
      'bracketMatching', 'find', 'folding', 'clipboard', 'multicursor',
      'wordHighlighter', 'hover', 'suggest', 'comment', 'indentation',
      'wordOperations', 'cursorUndo', 'smartSelect',
    ],
  }),
];
