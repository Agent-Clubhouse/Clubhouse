import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import path from 'path';
import fs from 'fs';
import os from 'os';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';
import { buildDevCsp } from './src/main/csp-nonce';

function copyNativeModule(srcRoot: string, destRoot: string, moduleName: string): void {
  const src = path.join(srcRoot, 'node_modules', moduleName);
  const dest = path.join(destRoot, 'node_modules', moduleName);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });

  // Also copy transitive native dependencies listed in the module's package.json
  const pkgPath = path.join(src, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const dep of Object.keys(deps)) {
      const depSrc = path.join(srcRoot, 'node_modules', dep);
      const depDest = path.join(destRoot, 'node_modules', dep);
      if (fs.existsSync(depSrc) && !fs.existsSync(depDest)) {
        fs.cpSync(depSrc, depDest, { recursive: true });
      }
    }
  }
}

// electron-winstaller's "modern" windowsSign.hookFunction path (used prior to
// this fix) makes @electron/windows-sign compile a Node "Single Executable
// Application" binary that stands in for signtool.exe, since Squirrel's own
// .NET Squirrel.Update.exe can only shell out to a real executable, never to
// JS directly. That SEA binary is freshly built and unsigned on every run
// (its own Node code-signature is stripped, then a blob is injected via
// postject) — exactly the profile Windows Defender's CI image flags and
// kills, which is what turned into the generic "Failed to sign" / exit
// 0xFFFFFFFF failures on beta.10.
//
// We don't need any of that JS-hook machinery: Trusted Signing only needs
// extra signtool.exe command-line flags (/dlib, /dmdf), which the "legacy"
// signWithParams option forwards verbatim to a real signtool.exe. The
// caveat is that signWithParams still signs with electron-winstaller's own
// *bundled* vendor/signtool.exe, which predates Trusted Signing and doesn't
// understand /dlib — so we point vendorDirectory at a copy of that vendor
// folder with signtool.exe swapped for the real Windows SDK one the release
// workflow already locates (see .github/workflows/release.yml).
function prepareTrustedSigningVendorDir(realSigntoolPath: string): string {
  const winstallerVendorDir = path.join(__dirname, 'node_modules', 'electron-winstaller', 'vendor');
  const vendorDir = path.join(os.tmpdir(), 'clubhouse-winstaller-vendor');
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.cpSync(winstallerVendorDir, vendorDir, { recursive: true });
  fs.copyFileSync(realSigntoolPath, path.join(vendorDir, 'signtool.exe'));
  return vendorDir;
}

const windowsSignConfig =
  process.env.AZURE_SIGNTOOL_PATH &&
  process.env.AZURE_TRUSTED_SIGNING_DLIB &&
  process.env.AZURE_TRUSTED_SIGNING_METADATA
    ? {
        vendorDirectory: prepareTrustedSigningVendorDir(process.env.AZURE_SIGNTOOL_PATH),
        signWithParams: [
          '/v',
          '/fd', 'SHA256',
          '/tr', 'http://timestamp.acs.microsoft.com',
          '/td', 'SHA256',
          '/dlib', `"${process.env.AZURE_TRUSTED_SIGNING_DLIB}"`,
          '/dmdf', `"${process.env.AZURE_TRUSTED_SIGNING_METADATA}"`,
        ].join(' '),
      }
    : {};

export const hardenedFuseValues = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
} as const;

export function findPackagedElectronBinary(outputPath: string): string | undefined {
  const queue = [outputPath];
  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath || !fs.existsSync(currentPath)) continue;

    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        const bundledAppBinary = path.join(fullPath, 'Contents', 'MacOS', 'Clubhouse');
        if (fs.existsSync(bundledAppBinary)) {
          return bundledAppBinary;
        }
        queue.push(fullPath);
        continue;
      }

      if (entry.name === 'Clubhouse' || entry.name === 'clubhouse' || entry.name === 'Clubhouse.exe') {
        return fullPath;
      }
    }
  }

  return undefined;
}

export async function assertHardenedFuseWire(appPath: string): Promise<void> {
  const currentWire = await getCurrentFuseWire(appPath);
  const mismatches: string[] = [];

  for (const [fuseKey, expectedValue] of Object.entries(hardenedFuseValues)) {
    const optionIndex = Number(fuseKey);
    const currentValue = currentWire[optionIndex];

    if (currentValue === undefined) {
      mismatches.push(`${FuseV1Options[optionIndex]} is unset`);
      continue;
    }

    const actualValue = currentValue === 49 ? true : currentValue === 48 ? false : undefined;
    if (actualValue === undefined) {
      mismatches.push(`${FuseV1Options[optionIndex]} has unexpected state ${currentValue}`);
      continue;
    }

    if (actualValue !== expectedValue) {
      mismatches.push(`${FuseV1Options[optionIndex]} expected ${expectedValue} but found ${actualValue}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Electron fuse assertion failed for ${appPath}: ${mismatches.join('; ')}`);
  }
}

/**
 * Linux `.deb`/`.rpm` packaging requires a lowercase binary name, so the
 * packager is told to emit `clubhouse` there.
 *
 * On macOS `executableName` also becomes `CFBundleDisplayName`, and it wins
 * over the explicit `extendInfo.CFBundleDisplayName` below — which made Finder,
 * Get Info and the Dock show a lowercase "clubhouse" while the menu bar (fed by
 * `CFBundleName`) showed "Clubhouse" (#1833). Scoping the override to Linux
 * keeps the bundle branded "Clubhouse" on every macOS surface.
 */
export function packagerExecutableName(
  platform: NodeJS.Platform = process.platform,
): { executableName?: string } {
  return platform === 'linux' ? { executableName: 'clubhouse' } : {};
}

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Clubhouse',
    ...packagerExecutableName(),
    appBundleId: 'com.mason-allen.clubhouse',
    icon: path.resolve(__dirname, 'assets', 'icon'),
    extendInfo: {
      CFBundleDisplayName: 'Clubhouse',
      NSUserNotificationAlertStyle: 'alert',
      NSLocalNetworkUsageDescription:
        'Clubhouse uses your local network to discover and connect to Annex companion devices.',
      NSBonjourServices: ['_clubhouse-annex._tcp.'],
      // Register the clubhouse:// custom URL scheme so the app can be invoked
      // via protocol links (open-file / open-folder). Windows/Linux register
      // the scheme at runtime via app.setAsDefaultProtocolClient.
      CFBundleURLTypes: [
        {
          CFBundleURLName: 'com.mason-allen.clubhouse',
          CFBundleURLSchemes: ['clubhouse'],
        },
      ],
    },
    osxSign: {
      identity: process.env.APPLE_SIGNING_IDENTITY || '-',
      optionsForFile: () => ({
        entitlements: path.resolve(__dirname, 'entitlements.plist'),
      }),
    },
    ...(process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID
      ? {
          osxNotarize: {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_ID_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID,
          },
        }
      : {}),
    asar: {
      unpack: '{**/node_modules/node-pty/**/*.node,**/node_modules/node-pty/**/spawn-helper,**/.webpack/main/bridge/clubhouse-mcp-bridge.js}',
    },
    afterCopy: [
      (buildPath: string, _electronVersion: string, _platform: string, _arch: string, callback: (err?: Error) => void) => {
        try {
          const projectRoot = path.resolve(__dirname);
          copyNativeModule(projectRoot, buildPath, 'node-pty');
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    ],
  },
  rebuildConfig: {
    onlyModules: [],
  },
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      icon: path.resolve(__dirname, 'assets', 'icon.icns'),
    }, ['darwin']),
    new MakerSquirrel({
      // The name is used to derive the AppUserModelID for the Start Menu shortcut.
      // It must align with the ID set by app.setAppUserModelId() in the main process
      // so Windows can route toast notifications to the correct app.
      name: 'com.mason-allen.clubhouse',
      iconUrl: 'https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse/main/assets/icon.ico',
      ...(fs.existsSync(path.resolve(__dirname, 'assets', 'icon.ico'))
        ? { setupIcon: path.resolve(__dirname, 'assets', 'icon.ico') }
        : {}),
      ...windowsSignConfig,
    }),
    new MakerDeb({
      options: {
        icon: path.resolve(__dirname, 'assets', 'icon.png'),
        maintainer: 'Agent Clubhouse',
        homepage: 'https://github.com/Agent-Clubhouse/Clubhouse',
        description: 'A place to hangout with your agent BFFs',
        categories: ['Utility', 'Development'],
        genericName: 'AI Chat Application',
      },
    }),
    new MakerRpm({
      options: {
        icon: path.resolve(__dirname, 'assets', 'icon.png'),
        homepage: 'https://github.com/Agent-Clubhouse/Clubhouse',
        description: 'A place to hangout with your agent BFFs',
        categories: ['Utility', 'Development'],
      },
    }),
  ],
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      for (const outputPath of packageResult.outputPaths) {
        const packagedAppPath = findPackagedElectronBinary(outputPath);
        if (!packagedAppPath) {
          console.warn(`Could not locate the packaged Clubhouse app under ${outputPath} for fuse verification (this is expected for some platforms)`);
          continue;
        }

        await assertHardenedFuseWire(packagedAppPath);
      }
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
    new WebpackPlugin({
      port: 3456,
      mainConfig,
      // Dev-only CSP (webpack dev server, http://localhost). Includes the
      // webpack-HMR relaxations plus the custom `clubhouse-plugin:` scheme so
      // the dev renderer can import plugin modules over it. Production CSP is
      // set separately via an HTTP header in src/main/index.ts. Kept in sync
      // with buildProductionCsp by csp-nonce tests.
      devContentSecurityPolicy: buildDevCsp(),
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/index.html',
            js: './src/renderer/index.ts',
            name: 'main_window',
            preload: {
              js: './src/preload/index.ts',
            },
          },
        ],
      },
    }),
  ],
};

export default config;
