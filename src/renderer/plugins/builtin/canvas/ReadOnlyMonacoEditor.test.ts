import { describe, it, expect } from 'vitest';
import { languageFromPath } from './ReadOnlyMonacoEditor';

describe('ReadOnlyMonacoEditor — languageFromPath', () => {
  it('detects TypeScript from .ts extension', () => {
    expect(languageFromPath('src/index.ts')).toBe('typescript');
  });

  it('detects TypeScript from .tsx extension', () => {
    expect(languageFromPath('components/App.tsx')).toBe('typescript');
  });

  it('detects JavaScript from .js extension', () => {
    expect(languageFromPath('lib/utils.js')).toBe('javascript');
  });

  it('detects Python from .py extension', () => {
    expect(languageFromPath('script.py')).toBe('python');
  });

  it('detects Rust from .rs extension', () => {
    expect(languageFromPath('main.rs')).toBe('rust');
  });

  it('detects Go from .go extension', () => {
    expect(languageFromPath('server.go')).toBe('go');
  });

  it('detects JSON from .json extension', () => {
    expect(languageFromPath('package.json')).toBe('json');
  });

  it('detects YAML from .yml extension', () => {
    expect(languageFromPath('config.yml')).toBe('yaml');
  });

  it('detects Markdown from .md extension', () => {
    expect(languageFromPath('README.md')).toBe('markdown');
  });

  it('detects CSS from .css extension', () => {
    expect(languageFromPath('styles.css')).toBe('css');
  });

  it('detects SCSS from .scss extension', () => {
    expect(languageFromPath('theme.scss')).toBe('scss');
  });

  it('detects HTML from .html extension', () => {
    expect(languageFromPath('index.html')).toBe('html');
  });

  it('detects shell from .sh extension', () => {
    expect(languageFromPath('build.sh')).toBe('shell');
  });

  it('detects SQL from .sql extension', () => {
    expect(languageFromPath('migrations/001.sql')).toBe('sql');
  });

  it('returns plaintext for unknown extension', () => {
    expect(languageFromPath('data.xyz')).toBe('plaintext');
  });

  it('returns plaintext for no extension', () => {
    expect(languageFromPath('LICENSE')).toBe('plaintext');
  });

  it('detects Dockerfile by filename', () => {
    expect(languageFromPath('dockerfile')).toBe('dockerfile');
  });

  it('detects Makefile by extension mapping', () => {
    expect(languageFromPath('makefile')).toBe('shell');
  });

  it('handles deeply nested paths', () => {
    expect(languageFromPath('src/renderer/plugins/builtin/canvas/FileTree.tsx')).toBe('typescript');
  });

  it('handles dotfiles with extensions', () => {
    expect(languageFromPath('.env')).toBe('ini');
  });

  it('handles .gitignore', () => {
    expect(languageFromPath('.gitignore')).toBe('ini');
  });

  it('is case-insensitive on extension', () => {
    expect(languageFromPath('README.MD')).toBe('markdown');
  });
});
