import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
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
    },
    osxSign: {
      identity: '-', // ad-hoc signing
      optionsForFile: () => ({
        entitlements: path.resolve(__dirname, 'entitlements.plist'),
      }),
    },
    asar: {
      unpack: '**/node_modules/node-pty/**',
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
    new MakerSquirrel({
      iconUrl: 'https://raw.githubusercontent.com/masonallen/Clubhouse/main/assets/icon.ico',
      setupIcon: path.resolve(__dirname, 'assets', 'icon.ico'),
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
