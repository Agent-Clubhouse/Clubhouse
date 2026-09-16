import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseAddressString,
  normalizeHost,
  isLoopbackHost,
  resolveLivenessAddress,
} from './goobers-address';

describe('parseAddressString', () => {
  it('parses host:port', () => {
    expect(parseAddressString('127.0.0.1:8080')).toEqual({ host: '127.0.0.1', port: 8080 });
  });

  it('parses bracketed IPv6', () => {
    expect(parseAddressString('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
  });

  it('parses a bare :port as a wildcard host', () => {
    expect(parseAddressString(':8080')).toEqual({ host: '0.0.0.0', port: 8080 });
  });

  it('returns null for empty input', () => {
    expect(parseAddressString('')).toBeNull();
    expect(parseAddressString('   ')).toBeNull();
  });

  it('returns null for an unparseable port', () => {
    expect(parseAddressString('127.0.0.1:not-a-port')).toBeNull();
    expect(parseAddressString('127.0.0.1:99999')).toBeNull();
  });

  it('returns null for a malformed bracketed IPv6 (missing close bracket)', () => {
    expect(parseAddressString('[::1:8080')).toBeNull();
  });
});

describe('normalizeHost', () => {
  it('normalizes wildcard binds for the client', () => {
    expect(normalizeHost('0.0.0.0')).toBe('127.0.0.1');
    expect(normalizeHost('::')).toBe('::1');
  });

  it('leaves a concrete host unchanged', () => {
    expect(normalizeHost('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHost('::1')).toBe('::1');
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback forms', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.5.5.5')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('rejects a non-loopback host', () => {
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('resolveLivenessAddress', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-address-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports absent when scheduler/api.address does not exist — no fallback probe (§7.4 step 1)', async () => {
    const result = await resolveLivenessAddress(tmpRoot);
    expect(result).toEqual({ status: 'absent' });
  });

  it('parses a well-formed address file', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'scheduler', 'api.address'), '127.0.0.1:8080');

    const result = await resolveLivenessAddress(tmpRoot);
    expect(result).toEqual({ status: 'ok', address: { host: '127.0.0.1', port: 8080 } });
  });

  it('normalizes a wildcard bind for the client', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'scheduler', 'api.address'), '0.0.0.0:9090');

    const result = await resolveLivenessAddress(tmpRoot);
    expect(result).toEqual({ status: 'ok', address: { host: '127.0.0.1', port: 9090 } });
  });

  it('rejects a non-loopback address as a hard error, never attempting to connect', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'scheduler', 'api.address'), '10.0.0.5:8080');

    const result = await resolveLivenessAddress(tmpRoot);
    expect(result).toEqual({ status: 'non-loopback', host: '10.0.0.5' });
  });

  it('retries an empty file rather than immediately reporting failure, and succeeds once it is written (the anti-flap case)', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });
    const addressPath = path.join(tmpRoot, 'scheduler', 'api.address');
    fs.writeFileSync(addressPath, ''); // simulate the daemon having just created, not yet written, the file

    // Write the real content shortly after the first read would have failed —
    // well within the ~1s retry window.
    setTimeout(() => fs.writeFileSync(addressPath, '127.0.0.1:8080'), 250);

    const result = await resolveLivenessAddress(tmpRoot);
    expect(result).toEqual({ status: 'ok', address: { host: '127.0.0.1', port: 8080 } });
  }, 3000);

  it('reports pending (not a hard failure) if the file never becomes parseable within the retry window', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'scheduler', 'api.address'), '');

    const result = await resolveLivenessAddress(tmpRoot);
    expect(result).toEqual({ status: 'pending' });
  }, 3000);
});
