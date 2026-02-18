import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { IPC } from '../../shared/ipc-channels';
import { getShellEnvironment } from '../util/shell';

interface ProcessExecRequest {
  pluginId: string;
  command: string;
  args: string[];
  allowedCommands: string[];
  projectPath: string;
  options?: { timeout?: number };
}

const MIN_TIMEOUT = 100;
const MAX_TIMEOUT = 60000;
const DEFAULT_TIMEOUT = 15000;

export function registerProcessHandlers(): void {
  ipcMain.handle(IPC.PROCESS.EXEC, (_event, req: ProcessExecRequest) => {
    const { command, args, allowedCommands, projectPath, options } = req;

    // Validate command is a bare name (no path separators or traversal)
    if (
      !command ||
      command.includes('/') ||
      command.includes('\\') ||
      command.includes('..')
    ) {
      return { stdout: '', stderr: `Invalid command: "${command}"`, exitCode: 1 };
    }

    // Validate command is in the manifest's allowedCommands
    if (!Array.isArray(allowedCommands) || !allowedCommands.includes(command)) {
      return { stdout: '', stderr: `Command "${command}" is not in allowedCommands`, exitCode: 1 };
    }

    // Clamp timeout
    let timeout = DEFAULT_TIMEOUT;
    if (options?.timeout !== undefined) {
      timeout = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, options.timeout));
    }

    return new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          shell: process.platform === 'win32', // .cmd/.bat commands need shell on Windows
          cwd: projectPath,
          timeout,
          env: getShellEnvironment(),
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error && (error as any).killed) {
            resolve({ stdout: stdout || '', stderr: stderr || 'Command timed out', exitCode: 124 });
            return;
          }
          // Non-zero exit: error.code is the exit status number
          const exitCode = error ? ((error as any).status ?? 1) : 0;
          resolve({
            stdout: stdout || '',
            stderr: stderr || (error ? error.message : ''),
            exitCode: typeof exitCode === 'number' ? exitCode : 1,
          });
        },
      );
    });
  });
}
