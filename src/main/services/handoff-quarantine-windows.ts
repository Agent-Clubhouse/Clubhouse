import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const exec = promisify(execFile);
// Fixed script only. Paths and the initialization decision travel through the
// environment, never PowerShell source or shell quoting (#2239).
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = $env:CLUBHOUSE_QUARANTINE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$entry = [System.IO.DirectoryInfo]::new($target)
if (-not $entry.Exists) { throw 'missing' }
while ($null -ne $entry) {
  if ($entry -isnot [System.IO.DirectoryInfo] -or ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'reparse' }
  $entry = $entry.Parent
}
if ($env:CLUBHOUSE_QUARANTINE_INITIALIZE -eq '1') {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $security.AddAccessRule($rule)
  [System.IO.Directory]::SetAccessControl($target, $security)
}
$acl = [System.IO.Directory]::GetAccessControl($target)
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
if (-not $acl.AreAccessRulesProtected) { throw 'inheritance' }
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw 'rules' }
$rule = $rules[0]
if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne 'None') { throw 'access' }
[Console]::Out.WriteLine('{"verified":true}')
`;

/** Only a newly/exclusively created root may have its DACL initialized. Existing
 * roots must already have precisely the current SID's protected, inheritable ACL. */
export async function verifyWindowsQuarantineRoot(directory: string, created: boolean): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  if (!path.win32.isAbsolute(systemRoot)) throw new Error('Unverified Windows quarantine root.');
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await exec(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
    env: { ...process.env, CLUBHOUSE_QUARANTINE_PATH: directory, CLUBHOUSE_QUARANTINE_INITIALIZE: created ? '1' : '0' },
    timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, shell: false,
  });
  if (result.stdout.trim() !== '{"verified":true}') throw new Error('Unverified Windows quarantine root.');
}
