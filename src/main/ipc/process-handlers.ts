import { ipcMain, app } from 'electron';
import { execFile } from 'child_process';
import { IPC } from '../../shared/ipc-channels';
import { getShellEnvironment } from '../util/shell';
import { getAllowedCommands, refreshManifest } from '../services/plugin-manifest-registry';
import { arrayArg, numberArg, objectArg, stringArg, withValidatedArgs } from './validation';

interface ProcessExecRequest {
  pluginId: string;
  command: string;
  args: string[];
  projectPath?: string;
  options?: { timeout?: number };
}

const MIN_TIMEOUT = 100;
const MAX_TIMEOUT = 60000;
const DEFAULT_TIMEOUT = 15000;

export function registerProcessHandlers(): void {
  ipcMain.handle(IPC.PROCESS.EXEC, withValidatedArgs([objectArg<ProcessExecRequest>({
    validate: (req, argName) => {
      stringArg({ optional: true, minLength: 0 })(req.pluginId, `${argName}.pluginId`);
      stringArg({ optional: true, minLength: 0 })(req.command, `${argName}.command`);
      arrayArg(stringArg())(req.args, `${argName}.args`);
      stringArg({ optional: true })(req.projectPath, `${argName}.projectPath`);
      objectArg<{ timeout?: number }>({
        optional: true,
        validate: (options, optionsArgName) => {
          if (options.timeout !== undefined) numberArg({ integer: true, min: 0 })(options.timeout, `${optionsArgName}.timeout`);
        },
      })(req.options, `${argName}.options`);
    },
  })], async (_event, req: ProcessExecRequest) => {
    const { pluginId, command, args, projectPath, options } = req;

    // Reject requests without a pluginId
    if (!pluginId) {
      return { stdout: '', stderr: 'Missing pluginId', exitCode: 1 };
    }

    // Validate command is a bare name (no path separators or traversal)
    if (
      !command ||
      command.includes('/') ||
      command.includes('\\') ||
      command.includes('..')
    ) {
      return { stdout: '', stderr: `Invalid command: "${command}"`, exitCode: 1 };
    }

    // Refresh from trusted main-process sources before enforcing policy.
    // The main process re-reads manifests from disk; renderer data is never used.
    await refreshManifest(pluginId);

    // Look up allowed commands from the server-side manifest registry
    // — never trust renderer-supplied allowedCommands.
    const allowedCommands = getAllowedCommands(pluginId);
    if (!allowedCommands.includes(command)) {
      return { stdout: '', stderr: `Command "${command}" not allowed for plugin "${pluginId}"`, exitCode: 1 };
    }

    // Clamp timeout
    let timeout = DEFAULT_TIMEOUT;
    if (options?.timeout !== undefined) {
      timeout = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, options.timeout));
    }

    const cwd = projectPath || app.getPath('home');

    return new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          shell: process.platform === 'win32', // .cmd/.bat commands need shell on Windows
          cwd,
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
  }));
}
