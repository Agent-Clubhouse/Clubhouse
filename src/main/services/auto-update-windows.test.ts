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

    it('waits before running installer to avoid file-lock contention', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      expect(script).toContain('timeout /t 2 /nobreak >nul');
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
      expect(lines.length).toBe(6);
    });

    it('executes steps in correct order: wait, install, relaunch, cleanup', () => {
      const script = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      const lines = script.split('\r\n');
      expect(lines[0]).toBe('@echo off');
      expect(lines[1]).toContain('timeout');
      expect(lines[2]).toContain('--silent');
      expect(lines[3]).toContain('--processStart');
      expect(lines[4]).toContain('del /f');
      expect(lines[5]).toContain('del "%~f0"');
    });
  });

  describe('buildWindowsQuitUpdateScript', () => {
    it('starts with @echo off', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script.startsWith('@echo off')).toBe(true);
    });

    it('waits before running installer to avoid file-lock contention', () => {
      const script = buildWindowsQuitUpdateScript(downloadPath);
      expect(script).toContain('timeout /t 2 /nobreak >nul');
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
      expect(lines.length).toBe(5);
    });

    it('has one fewer line than the update script (no relaunch)', () => {
      const updateScript = buildWindowsUpdateScript(downloadPath, updateExePath, appExeName);
      const quitScript = buildWindowsQuitUpdateScript(downloadPath);
      expect(quitScript.split('\r\n').length).toBe(updateScript.split('\r\n').length - 1);
    });
  });
});
