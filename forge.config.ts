import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import path from 'path';
import fs from 'fs';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

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

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Clubhouse',
    appBundleId: 'com.mason-allen.clubhouse',
    icon: path.resolve(__dirname, 'assets', 'icon'),
    extendInfo: {
      CFBundleDisplayName: 'Clubhouse',
      NSUserNotificationAlertStyle: 'alert',
      NSMicrophoneUsageDescription: 'Clubhouse needs microphone access for voice input and speech-to-text.',
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
      unpack: '{**/node_modules/node-pty/**/*.node,**/node_modules/node-pty/**/spawn-helper}',
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
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      icon: path.resolve(__dirname, 'assets', 'icon.icns'),
    }, ['darwin']),
    new MakerSquirrel({
      iconUrl: 'https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse/main/assets/icon.ico',
      ...(fs.existsSync(path.resolve(__dirname, 'assets', 'icon.ico'))
        ? { setupIcon: path.resolve(__dirname, 'assets', 'icon.ico') }
        : {}),
    }),
    new MakerDeb({
      options: {
        icon: path.resolve(__dirname, 'assets', 'icon.png'),
      },
    }),
    new MakerRpm({
      options: {
        icon: path.resolve(__dirname, 'assets', 'icon.png'),
      },
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      port: 3456,
      mainConfig,
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
