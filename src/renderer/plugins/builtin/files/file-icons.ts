// Extension-to-Monaco language mapping
export const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less',
  py: 'python', pyw: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'cpp', c: 'cpp',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', xsl: 'xml', xslt: 'xml', svg: 'xml',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  dart: 'dart',
  dockerfile: 'dockerfile',
  graphql: 'graphql', gql: 'graphql',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  makefile: 'shell',
  env: 'ini',
  gitignore: 'ini',
};

// Color classes for file icons by extension
export function getFileIconColor(ext: string): string {
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts':
      return 'text-ctp-info';
    case 'js': case 'jsx': case 'mjs': case 'cjs':
      return 'text-ctp-warning';
    case 'py': case 'pyw':
      return 'text-ctp-success';
    case 'rs':
      return 'text-ctp-warning';
    case 'go':
      return 'text-ctp-info';
    case 'java': case 'kt': case 'kts':
      return 'text-ctp-warning';
    case 'swift':
      return 'text-ctp-warning';
    case 'cs':
      return 'text-ctp-accent';
    case 'html': case 'htm':
      return 'text-ctp-warning';
    case 'css': case 'scss': case 'less':
      return 'text-ctp-info';
    case 'json': case 'jsonc':
      return 'text-ctp-warning';
    case 'md': case 'mdx':
      return 'text-ctp-success';
    case 'yaml': case 'yml': case 'toml':
      return 'text-ctp-accent';
    case 'sh': case 'bash': case 'zsh': case 'fish':
      return 'text-ctp-success';
    case 'sql':
      return 'text-ctp-info';
    case 'svg':
      return 'text-ctp-warning';
    case 'xml': case 'xsl': case 'xslt':
      return 'text-ctp-warning';
    case 'rb':
      return 'text-ctp-accent';
    case 'php':
      return 'text-ctp-accent';
    case 'lua':
      return 'text-ctp-info';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'h': case 'c':
      return 'text-ctp-info';
    default:
      return 'text-ctp-subtext0';
  }
}

export const BINARY_EXTENSIONS = new Set([
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flac', 'wav', 'ogg', 'webm',
  'pyc', 'class', 'o', 'obj',
  'sqlite', 'db',
]);

export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp',
]);
