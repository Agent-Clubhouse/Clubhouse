/**
 * Read-only Antigravity profile reads (#3794): allowlisted fields only, names
 * only from the global MCP config, BOM and comment tolerant, all under a temp
 * HOME whose bytes must not change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  listInheritedProfilePaths, memberOf, parseJsonc, readAntigravityProfile, readGlobalMcpServerNames, serverNamesOf, toPlain,
} from './profile-reads';

let home: string;
const settingsFile = () => path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
const mcpFile = () => path.join(home, '.gemini', 'config', 'mcp_config.json');
const put = async (file: string, text: string) => { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, text); };

beforeEach(async () => { home = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-profile-')); });
afterEach(async () => { await fsp.rm(home, { recursive: true, force: true }); });

describe('parseJsonc', () => {
  it('accepts a BOM, line and block comments, and trailing commas', () => {
    const text = '﻿// head\n{ /* a */ "a": [1, 2,], "b": {"c": "//not a comment",}, }';
    const root = parseJsonc(text);
    expect(toPlain(root)).toEqual({ a: [1, 2], b: { c: '//not a comment' } });
    const a = memberOf(root, 'a');
    expect(a && a !== 'duplicate' && text.slice(a.keyStart, a.keyStart + 3)).toBe('"a"');
  });

  it.each(['{', '{"a" 1}', '{a: 1}', '{"a": 1} x', '/* open', '{"a": "\n"}'])('rejects %j', (text) => {
    expect(() => parseJsonc(text)).toThrow();
  });

  it('reports duplicate keys', () => {
    expect(memberOf(parseJsonc('{"a": 1, "a": 2}'), 'a')).toBe('duplicate');
  });
});

describe('readAntigravityProfile', () => {
  it('returns only auth.type, modelProvider and agentMode', async () => {
    await put(settingsFile(), '﻿{\n // c\n "auth": {"type": "oauth-personal", "token": "SECRET"},\n "modelProvider": "gemini",\n "agentMode": "agent",\n "gcp": {"project": "p"},\n "permissions": {"allow": ["x"]},\n}');
    const result = await readAntigravityProfile(home);
    expect(result).toEqual({ status: 'ok', facts: { authType: 'oauth-personal', modelProvider: 'gemini', agentMode: 'agent' } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|gcp|permissions/);
  });

  it('drops values outside a short identifier shape', async () => {
    await put(settingsFile(), '{"auth": {"type": "AIza secret key with spaces"}, "modelProvider": 42}');
    expect(await readAntigravityProfile(home)).toEqual({ status: 'ok', facts: {} });
  });

  it('absent, unparsable and duplicate-key files', async () => {
    expect(await readAntigravityProfile(home)).toEqual({ status: 'absent' });
    await put(settingsFile(), 'agentMode: agent'); // Hjson-only syntax: unknown, never a guess
    expect(await readAntigravityProfile(home)).toEqual({ status: 'unknown' });
    await put(settingsFile(), '{"modelProvider": "a", "modelProvider": "b"}');
    expect(await readAntigravityProfile(home)).toEqual({ status: 'unknown' });
  });
});

describe('readGlobalMcpServerNames', () => {
  it('returns names only', async () => {
    await put(mcpFile(), '﻿{/* x */ "mcpServers": {"a": {"command": "c", "env": {"K": "SECRET"}}, "b": {"serverUrl": "u", "headers": {"H": "SECRET"}},}}');
    const result = await readGlobalMcpServerNames(home);
    expect(result).toEqual({ status: 'ok', names: ['a', 'b'] });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('absent and unreadable', async () => {
    expect(await readGlobalMcpServerNames(home)).toEqual({ status: 'absent' });
    expect(serverNamesOf('{"mcpServers": [] }')).toMatchObject({ status: 'unreadable' });
    expect(serverNamesOf('{"mcpServers": {}, "mcpServers": {}}')).toMatchObject({ status: 'unreadable' });
    expect(serverNamesOf('{}')).toEqual({ status: 'ok', names: [] });
    await put(mcpFile(), 'nope');
    expect(await readGlobalMcpServerNames(home)).toMatchObject({ status: 'unreadable' });
  });
});

describe('listInheritedProfilePaths', () => {
  it('lists existing documented paths without changing any bytes', async () => {
    await put(path.join(home, '.gemini', 'GEMINI.md'), 'rules');
    await fsp.mkdir(path.join(home, '.gemini', 'config', 'skills'), { recursive: true });
    await put(mcpFile(), '{}');
    const before = fs.readdirSync(path.join(home, '.gemini'), { recursive: true }).map(String).sort();
    const found = await listInheritedProfilePaths(home);
    expect(found).toEqual([
      path.join(home, '.gemini', 'GEMINI.md'),
      path.join(home, '.gemini', 'config', 'skills'),
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
    ]);
    expect(fs.readdirSync(path.join(home, '.gemini'), { recursive: true }).map(String).sort()).toEqual(before);
    expect(await fsp.readFile(mcpFile(), 'utf-8')).toBe('{}');
  });
});
