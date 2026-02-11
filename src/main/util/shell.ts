import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const CLAUDE_NAMES = ['claude'];

export function findClaudeBinary(): string {
  // Check common locations first
  const commonPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(process.env.HOME || '', '.npm-global/bin/claude'),
    path.join(process.env.HOME || '', '.local/bin/claude'),
    path.join(process.env.HOME || '', '.claude/local/claude'),
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Try which/where
  for (const name of CLAUDE_NAMES) {
    try {
      const result = execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
      if (result && fs.existsSync(result)) {
        return result;
      }
    } catch {
      // continue
    }
  }

  throw new Error(
    'Could not find the claude CLI binary. Make sure it is installed and on your PATH.'
  );
}
