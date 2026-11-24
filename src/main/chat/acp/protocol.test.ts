import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_ERROR_CODES,
  ACP_PERMISSION_OPTION_KINDS,
  ACP_PROTOCOL_METHODS,
  ACP_SCHEMA_SOURCE,
  ACP_SESSION_UPDATE_KINDS,
  ACP_STOP_REASONS,
  ACP_TOOL_CALL_STATUSES,
  ACP_TOOL_KINDS,
} from './protocol';

const schemaDir = path.join(__dirname, 'schema');
const schemaBytes = fs.readFileSync(path.join(schemaDir, 'schema.v1.json'));
const provenance = fs.readFileSync(path.join(schemaDir, 'PROVENANCE.md'), 'utf8');
type Def = { oneOf?: Array<Record<string, unknown>>; anyOf?: Array<Record<string, unknown>>; 'x-side'?: string; 'x-method'?: string };
const defs = (JSON.parse(schemaBytes.toString('utf8')) as { $defs: Record<string, Def> }).$defs;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function methods(side: string): string[] {
  return [...new Set(Object.values(defs).filter((d) => d['x-side'] === side && d['x-method']).map((d) => d['x-method']!))].sort();
}

function consts(def: string): string[] {
  return (defs[def].oneOf ?? []).map((v) => v.const as string);
}

describe('ACP schema pin', () => {
  it('vendors the exact bytes recorded in PROVENANCE.md', () => {
    expect(provenance).toContain(`| Version | \`${ACP_SCHEMA_SOURCE.version}\` |`);
    expect(provenance).toContain(`| \`schema.v1.json\` sha256 | \`${sha256(schemaBytes)}\` |`);
    expect(provenance).toContain(`| \`LICENSE\` sha256 | \`${sha256(fs.readFileSync(path.join(schemaDir, 'LICENSE')))}\` |`);
  });

  it('is the stable schema: no unstable-only methods', () => {
    expect(methods('agent')).not.toContain('session/fork');
    expect(methods('proxy')).toEqual([]);
  });

  it('method tables match the schema', () => {
    expect(Object.values(ACP_AGENT_METHODS).sort()).toEqual(methods('agent'));
    expect(Object.values(ACP_CLIENT_METHODS).sort()).toEqual(methods('client'));
    expect(Object.values(ACP_PROTOCOL_METHODS).sort()).toEqual(methods('protocol'));
  });

  it('session/update variants match the schema', () => {
    const variants = (defs.SessionUpdate.oneOf ?? []).map((v) => (v.properties as { sessionUpdate: { const: string } }).sessionUpdate.const);
    expect([...ACP_SESSION_UPDATE_KINDS]).toEqual(variants);
  });

  it('enumerations match the schema', () => {
    expect([...ACP_STOP_REASONS]).toEqual(consts('StopReason'));
    expect([...ACP_PERMISSION_OPTION_KINDS]).toEqual(consts('PermissionOptionKind'));
    expect([...ACP_TOOL_KINDS]).toEqual(consts('ToolKind'));
    expect([...ACP_TOOL_CALL_STATUSES]).toEqual(consts('ToolCallStatus'));
  });

  it('error codes match the schema', () => {
    const named = (defs.ErrorCode.anyOf ?? []).filter((v) => typeof v.const === 'number').map((v) => v.const as number).sort();
    expect(Object.values(ACP_ERROR_CODES).sort()).toEqual(named);
  });

  it('the capabilities the driver reads exist in the schema', () => {
    const props = (name: string) => Object.keys((defs[name] as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props('AgentCapabilities')).toEqual(expect.arrayContaining(['loadSession', 'promptCapabilities', 'mcpCapabilities', 'sessionCapabilities']));
    expect(props('SessionCapabilities')).toEqual(expect.arrayContaining(['resume', 'close', 'list', 'systemPrompt']));
    expect(props('ClientCapabilities')).toEqual(expect.arrayContaining(['fs', 'terminal', 'elicitation']));
    expect(props('ElicitationCapabilities')).toEqual(expect.arrayContaining(['form']));
  });
});
