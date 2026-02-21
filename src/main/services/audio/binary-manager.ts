import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export type BinaryName = 'whisper-cpp' | 'piper' | 'parakeet';

export const BINARY_FILENAMES: Record<string, Record<BinaryName, string>> = {
  darwin: { 'whisper-cpp': 'main', piper: 'piper', parakeet: 'parakeet' },
  linux: { 'whisper-cpp': 'main', piper: 'piper', parakeet: 'parakeet' },
  win32: { 'whisper-cpp': 'main.exe', piper: 'piper.exe', parakeet: 'parakeet.exe' },
};

export class BinaryManager {
  private basePath: string;

  constructor() {
    this.basePath = path.join(app.getPath('userData'), 'audio', 'bin');
  }

  getBinaryPath(binary: BinaryName): string {
    const filename = BINARY_FILENAMES[process.platform]?.[binary] ?? binary;
    return path.join(this.basePath, binary, filename);
  }

  async isInstalled(binary: BinaryName): Promise<boolean> {
    return fs.existsSync(this.getBinaryPath(binary));
  }

  async install(binary: BinaryName, onProgress: (pct: number) => void): Promise<void> {
    const dir = path.join(this.basePath, binary);
    fs.mkdirSync(dir, { recursive: true });
    // Download logic will be implemented when integrating with real download URLs.
    onProgress(100);
  }
}
