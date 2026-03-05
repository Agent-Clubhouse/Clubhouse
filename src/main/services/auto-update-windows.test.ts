import { describe, it, expect } from 'vitest';
import { buildWindowsUpdateScript, buildWindowsQuitUpdateScript } from './auto-update-service';

describe('auto-update-service: Windows batch script builders', () => {
  const downloadPath = 'C:\\Users\\test\\AppData\\Local\\Temp\\clubhouse-updates\\Clubhouse-0.26.0.exe';
  const updateExePath = 'C:\\Users\\test\\AppData\\Local\\Clubhouse\\Update.exe';
  const appExeName = 'Clubhouse.exe';

  describe('buildWindowsUpdateScript', () => {
    it('starts with @echo off', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      expect(script.startsWith('@echo off')).toBe(true);
    });

    it('uses ping for delay instead of timeout (works without a console)', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      expect(script).toContain('ping -n 4 127.0.0.1 >nul');
      expect(script).not.toContain('timeout');
    });

    it('runs the installer silently', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      expect(script).toContain(`"${downloadPath}" --silent`);
    });

    it('relaunches the app via Update.exe --processStart', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      expect(script).toContain(`"${updateExePath}" --processStart "${appExeName}"`);
    });

    it('cleans up the downloaded installer', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      expect(script).toContain(`del /f "${downloadPath}" 2>nul`);
    });

    it('self-deletes the batch script', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      expect(script).toContain('del "%~f0"');
    });

    it('uses CRLF line endings', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      const lines = script.split('\r\n');
      expect(lines.length).toBe(9);
    });

    it('logs installer execution and exit code', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      expect(script).toContain('Running installer:');
      expect(script).toContain('Installer exit code: %ERRORLEVEL%');
      expect(script).toContain('clubhouse-update.log');
    });

    it('logs a failure message when installer returns non-zero', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      expect(script).toContain('IF %ERRORLEVEL% NEQ 0');
      expect(script).toContain('Installer FAILED');
    });

    it('executes steps in correct order: wait, log, install, log, check, relaunch, cleanup', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      const lines = script.split('\r\n');
      expect(lines[0]).toBe('@echo off');
      expect(lines[1]).toContain('ping');
      expect(lines[2]).toContain('Running installer');
      expect(lines[3]).toContain('--silent');
      expect(lines[4]).toContain('exit code');
      expect(lines[5]).toContain('IF %ERRORLEVEL%');
      expect(lines[6]).toContain('--processStart');
      expect(lines[7]).toContain('del /f');
      expect(lines[8]).toContain('del "%~f0"');
    });
  });

  describe('buildWindowsQuitUpdateScript', () => {
    it('starts with @echo off', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script.startsWith('@echo off')).toBe(true);
    });

    it('uses ping for delay instead of timeout (works without a console)', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script).toContain('ping -n 4 127.0.0.1 >nul');
      expect(script).not.toContain('timeout');
    });

    it('runs the installer silently', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script).toContain(`"${downloadPath}" --silent`);
    });

    it('does NOT relaunch the app', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script).not.toContain('processStart');
      expect(script).not.toContain('Update.exe');
    });

    it('cleans up the downloaded installer', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script).toContain(`del /f "${downloadPath}" 2>nul`);
    });

    it('self-deletes the batch script', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script).toContain('del "%~f0"');
    });

    it('uses CRLF line endings', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      const lines = script.split('\r\n');
      expect(lines.length).toBe(8);
    });

    it('logs installer execution and exit code', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script).toContain('Running installer (quit):');
      expect(script).toContain('Installer exit code: %ERRORLEVEL%');
      expect(script).toContain('clubhouse-update.log');
    });

    it('logs a failure message when installer returns non-zero', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script).toContain('IF %ERRORLEVEL% NEQ 0');
      expect(script).toContain('Installer FAILED');
    });

    it('has one fewer line than the update script (no relaunch)', () => {
      const updateScript = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      const quitScript = buildWindowsQuitUpdateScript(downloadPath);
      expect(quitScript.split('\r\n').length).toBe(updateScript.split('\r\n').length - 1);
    });
  });
});
