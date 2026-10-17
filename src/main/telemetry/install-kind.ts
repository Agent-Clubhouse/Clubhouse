/**
 * How this copy of Clubhouse was installed (spec §12 H6). Several update
 * regressions only hit one install kind (#1647 rpm, #1650/#1698 deb). The
 * Linux check runs asynchronously and is cached; it never blocks startup the
 * way the update service's synchronous dpkg/rpm probe would.
 */
import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import { app } from 'electron';

export type InstallKind = 'mac_zip' | 'squirrel' | 'deb' | 'rpm' | 'appimage' | 'linux_other' | 'dev';

const PACKAGE_NAMES = ['clubhouse', 'Clubhouse'];
let cached: Promise<InstallKind> | null = null;

function rpmHas(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('rpm', ['-q', name], { timeout: 3000 }, (err, stdout) => {
      resolve(!err && typeof stdout === 'string' && stdout.trim().toLowerCase().startsWith(name.toLowerCase()));
    });
  });
}

async function detect(): Promise<InstallKind> {
  if (!app.isPackaged) return 'dev';
  if (process.platform === 'darwin') return 'mac_zip';
  if (process.platform === 'win32') return 'squirrel';
  if (process.platform !== 'linux') return 'linux_other';
  if (process.env.APPIMAGE) return 'appimage';
  for (const name of PACKAGE_NAMES) {
    try {
      await fsp.access(`/var/lib/dpkg/info/${name}.list`);
      return 'deb';
    } catch {
      // telemetry-exempt: probing for an optional dpkg record
    }
  }
  for (const name of PACKAGE_NAMES) {
    if (await rpmHas(name)) return 'rpm';
  }
  return 'linux_other';
}

export function getInstallKind(): Promise<InstallKind> {
  if (!cached) cached = detect().catch(() => 'linux_other' as const);
  return cached;
}

/** Test-only reset. */
export function _resetInstallKindForTests(): void {
  cached = null;
}
