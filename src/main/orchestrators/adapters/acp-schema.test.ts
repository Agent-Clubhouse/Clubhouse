import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_PERMISSION_OPTION_KINDS,
  ACP_PROTOCOL_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_SCHEMA_VERSION,
  ACP_SESSION_UPDATE_KINDS,
  ACP_STOP_REASONS,
  ACP_TOOL_CALL_STATUSES,
  ACP_TOOL_KINDS,
} from './acp-schema';

const schemaDir = path.join(__dirname, '__fixtures__', 'acp', `schema-v${ACP_SCHEMA_VERSION}`);
const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, 'schema.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(schemaDir, 'meta.json'), 'utf8'));
const defs = schema.$defs as Record<string, { oneOf?: Array<Record<string, unknown>> }>;

function constsOf(def: string): string[] {
  return (defs[def].oneOf ?? []).map((v) => v.const as string);
}

describe('ACP schema pin', () => {
  it('vendors the pinned schema version', () => {
    expect(meta.version).toBe(ACP_PROTOCOL_VERSION);
  });

  it('method tables match meta.json', () => {
    expect(Object.values(ACP_AGENT_METHODS).sort()).toEqual(Object.values(meta.agentMethods).sort());
    expect(Object.values(ACP_CLIENT_METHODS).sort()).toEqual(Object.values(meta.clientMethods).sort());
    expect(Object.values(ACP_PROTOCOL_METHODS).sort()).toEqual(Object.values(meta.protocolMethods).sort());
  });

  it('session/update variants match the schema', () => {
    const variants = (defs.SessionUpdate.oneOf ?? []).map(
      (v) => (v.properties as { sessionUpdate: { const: string } }).sessionUpdate.const,
    );
    expect([...ACP_SESSION_UPDATE_KINDS]).toEqual(variants);
  });

  it('enumerations match the schema', () => {
    expect([...ACP_STOP_REASONS]).toEqual(constsOf('StopReason'));
    expect([...ACP_PERMISSION_OPTION_KINDS]).toEqual(constsOf('PermissionOptionKind'));
    expect([...ACP_TOOL_KINDS]).toEqual(constsOf('ToolKind'));
    expect([...ACP_TOOL_CALL_STATUSES]).toEqual(constsOf('ToolCallStatus'));
  });
});
