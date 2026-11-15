import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyWindowsQuarantineRoot } from './handoff-quarantine-windows';

const execution = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  execution.exec = vi.fn(promisify(actual.execFile));
  return { ...actual, execFile: Object.assign(vi.fn(actual.execFile), { [promisify.custom]: execution.exec }) };
});
const exec = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

it('keeps hostile path characters in the environment, outside the fixed PowerShell script', async () => {
  execution.exec.mockResolvedValue({ stdout: '{"verified":true}\r\n' });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  const hostile = "C:\\Users\\person\\a';$(Write-Output injected);`echo`";
  await verifyWindowsQuarantineRoot(hostile, true);
  const [executable, args, options] = execution.exec.mock.calls[0];
  expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  expect(script).not.toContain(hostile);
  expect(script).not.toMatch(/(?:Get|Set)-Acl|Get-Item|Write-Output/);
  expect(script).toContain('[System.IO.Directory]::GetAccessControl');
  expect(script).toContain('[System.IO.Directory]::SetAccessControl');
  expect(script).not.toContain('Write-Output injected');
  expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 10_000, env: { CLUBHOUSE_QUARANTINE_PATH: hostile, CLUBHOUSE_QUARANTINE_INITIALIZE: '1' } });
  await verifyWindowsQuarantineRoot('C:\\Users\\other', false);
  expect(execution.exec.mock.calls[1][1]).toEqual(args);
  expect(execution.exec.mock.calls[1][2].env.CLUBHOUSE_QUARANTINE_INITIALIZE).toBe('0');
});

it.each(['', 'true', '{"verified":false}', '{"verified":true}\nextra'])('refuses unverified ACL output %j', async (stdout) => {
  execution.exec.mockResolvedValue({ stdout });
  await expect(verifyWindowsQuarantineRoot('C:\\Users\\me\\q', false)).rejects.toThrow();
});

it('refuses failed or timed out ACL checks', async () => {
  for (const error of [Object.assign(new Error('failure'), { code: 1 }), Object.assign(new Error('timeout'), { killed: true })]) {
    execution.exec.mockRejectedValueOnce(error);
    await expect(verifyWindowsQuarantineRoot('C:\\Users\\me\\q', false)).rejects.toThrow();
  }
});

it.skipIf(process.platform !== 'win32')('initializes and verifies a private SID/DACL and refuses inherited or broadened ACLs', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-q-acl-'));
  const directory = path.join(parent, "q';$(Write-Output injected);`echo`");
  fs.mkdirSync(directory);
  try {
    await expect(verifyWindowsQuarantineRoot(directory, false)).rejects.toThrow();
    await verifyWindowsQuarantineRoot(directory, true);
    await verifyWindowsQuarantineRoot(directory, false);
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    await exec(path.join(systemRoot, 'System32', 'icacls.exe'), [directory, '/grant', '*S-1-1-0:(OI)(CI)R']);
    await expect(verifyWindowsQuarantineRoot(directory, false)).rejects.toThrow();
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(process.platform !== 'win32')('accepts the normal LOCALAPPDATA ancestor chain', async () => {
  expect(process.env.LOCALAPPDATA).toBeDefined();
  const directory = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA!, 'ch-q-acl-chain-'));
  try {
    await verifyWindowsQuarantineRoot(directory, true);
    await verifyWindowsQuarantineRoot(directory, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
