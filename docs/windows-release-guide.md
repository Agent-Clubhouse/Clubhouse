# Windows Release Guide

This document covers how Windows releases work for Clubhouse, what infrastructure is already in place, and what manual steps (if any) are needed.

## Overview

Windows releases use the **Squirrel.Windows** installer framework via Electron Forge's `MakerSquirrel`. The release pipeline produces a `Clubhouse-{version}-win32-x64-Setup.exe` installer that handles both fresh installs and in-place updates.

### How It Works

1. **Build**: GitHub Actions runs `electron-forge make` on a `windows-latest` runner (x64)
2. **Artifact**: MakerSquirrel produces a Setup.exe containing the app and Squirrel's `Update.exe`
3. **Publish**: The Setup.exe is uploaded to Azure Blob Storage and included in the GitHub Release
4. **Update Manifest**: `latest.json` includes a `win32-x64` entry pointing to the Setup.exe
5. **Auto-Update**: The app downloads the new Setup.exe, runs it with `--silent`, and exits

### Installation Path

Squirrel installs to `%LOCALAPPDATA%\Clubhouse\`. This is a per-user install — no admin privileges required. The directory structure:

```
%LOCALAPPDATA%\Clubhouse\
├── Update.exe              # Squirrel's update manager
├── app-{version}/          # Current app version
│   ├── Clubhouse.exe
│   ├── resources/
│   └── ...
├── packages/               # Squirrel nupkg cache
└── Clubhouse.exe           # Shortcut stub
```

### Auto-Update Flow

1. App checks `latest.json` every 4 hours (or manually via Settings)
2. If a newer version exists and a `win32-x64` artifact is present, downloads the Setup.exe
3. SHA-256 checksum is verified against the manifest
4. User clicks "Update Now" — app spawns the Setup.exe with `--silent` and exits
5. Squirrel updates the app in-place and relaunches it
6. On relaunch, `electron-squirrel-startup` handles Squirrel lifecycle events

## What's Already Configured (No Action Needed)

These are already set up in the codebase:

- **`forge.config.ts`**: `MakerSquirrel` configured with icon URLs
- **`assets/icon.ico`**: Windows icon for the installer
- **`src/main/index.ts`**: `electron-squirrel-startup` handles Squirrel events
- **`scripts/fix-node-pty-win.js`**: Fixes node-pty native compilation on Windows
- **`auto-update-service.ts`**: Windows update path (spawns Setup.exe with `--silent`)
- **`.github/workflows/release.yml`**: `build-windows` job produces x64 installer
- **`.github/workflows/validate.yml`**: Typecheck and unit tests already run on Windows

## Manual Steps Required

### None for basic unsigned releases

The pipeline is fully automated. When you push a signed tag (`v*`), the Windows build runs alongside macOS builds. The Setup.exe is uploaded to Azure Blob Storage and included in the GitHub Release — no additional secrets or configuration needed.

### SmartScreen Warning

Without code signing, Windows users will see a **"Windows protected your PC"** SmartScreen warning on first run. They can click "More info" > "Run anyway" to proceed. This warning goes away over time as Microsoft builds reputation for the app based on download volume.

## Future: Adding Windows Code Signing

When you're ready to eliminate SmartScreen warnings, here are your options:

### Option A: Azure Trusted Signing (Recommended, ~$10/month)

Azure Trusted Signing is the most cost-effective option and integrates well with the existing Azure infrastructure.

1. **Enable Azure Trusted Signing** in your Azure subscription
2. **Create a Trusted Signing account** and certificate profile
3. **Add GitHub Action secrets**:
   - `AZURE_CODE_SIGNING_ENDPOINT`
   - `AZURE_CODE_SIGNING_ACCOUNT`
   - `AZURE_CODE_SIGNING_PROFILE`
4. **Add a signing step** to the `build-windows` job (after `electron-forge make`, before hash computation):
   ```yaml
   - name: Sign Windows installer
     uses: azure/trusted-signing-action@v0.5.0
     with:
       azure-tenant-id: ${{ secrets.AZURE_TENANT_ID }}
       azure-client-id: ${{ secrets.AZURE_CLIENT_ID }}
       azure-client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
       endpoint: ${{ secrets.AZURE_CODE_SIGNING_ENDPOINT }}
       trusted-signing-account-name: ${{ secrets.AZURE_CODE_SIGNING_ACCOUNT }}
       certificate-profile-name: ${{ secrets.AZURE_CODE_SIGNING_PROFILE }}
       files-folder: out/make
       files-folder-filter: exe
       file-digest: SHA256
       timestamp-rfc3161: http://timestamp.acs.microsoft.com
       timestamp-digest: SHA256
   ```

### Option B: Traditional Code Signing Certificate (~$200-500/year)

Purchase from DigiCert, Sectigo, or SSL.com. Requires:

1. **Buy an EV or OV code signing certificate**
   - EV (Extended Validation): Immediate SmartScreen trust, ~$400-500/yr
   - OV (Organization Validation): Builds trust over time, ~$200-300/yr
2. **Export as PFX/P12** and base64-encode it
3. **Add GitHub Action secrets**:
   - `WIN_CERTIFICATE_P12`: Base64-encoded PFX
   - `WIN_CERTIFICATE_PASSWORD`: PFX password
4. **Add signing step** using `signtool.exe` (available on Windows runners):
   ```yaml
   - name: Sign Windows installer
     shell: pwsh
     env:
       WIN_CERTIFICATE_P12: ${{ secrets.WIN_CERTIFICATE_P12 }}
       WIN_CERTIFICATE_PASSWORD: ${{ secrets.WIN_CERTIFICATE_PASSWORD }}
     run: |
       $certPath = "$env:RUNNER_TEMP\cert.pfx"
       [System.IO.File]::WriteAllBytes($certPath, [System.Convert]::FromBase64String($env:WIN_CERTIFICATE_P12))

       $exe = Get-ChildItem -Path out/make -Recurse -Filter "*Setup*.exe" | Select-Object -First 1
       & "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe" sign `
         /f $certPath /p $env:WIN_CERTIFICATE_PASSWORD `
         /tr http://timestamp.digicert.com /td SHA256 /fd SHA256 `
         $exe.FullName

       Remove-Item $certPath
   ```

## Troubleshooting

### node-pty build failures on Windows CI

The `scripts/fix-node-pty-win.js` postinstall script patches node-pty's gyp files to:
- Disable Spectre mitigation (requires special MSVC libraries not on CI runners)
- Fix bat script paths that break under gyp's working directory
- Generate `GenVersion.h` header

If node-pty compilation fails, check that `npm ci` ran the postinstall script.

### Squirrel events not handled

If the app launches but immediately quits after install/update, verify that `electron-squirrel-startup` is the first thing checked in `src/main/index.ts` (before any other app initialization).

### Auto-updater not finding Windows artifact

The update manifest key must be `win32-x64` (matching `${process.platform}-${process.arch}`). Verify `latest.json` contains this key after a release.
