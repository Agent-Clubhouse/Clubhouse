/**
 * Runtime type validation utilities for MCP tool handler arguments.
 *
 * All MCP tool arguments arrive as `Record<string, unknown>` from LLM callers.
 * These helpers provide safe extraction with clear error messages, replacing
 * unsafe `as string` / `as number` casts throughout the tool handlers.
 */

export class McpArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpArgError';
  }
}

/** Extract a required string argument. Throws McpArgError if missing or wrong type. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string') {
    throw new McpArgError(`${key} must be a string, got ${val === null ? 'null' : typeof val}`);
  }
  return val;
}

/** Extract an optional string argument. Returns undefined if absent/null, throws if wrong type. */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new McpArgError(`${key} must be a string, got ${typeof val}`);
  }
  return val;
}

/** Extract a string argument with a default value. */
export function stringWithDefault(args: Record<string, unknown>, key: string, defaultValue: string): string {
  const val = args[key];
  if (val === undefined || val === null) return defaultValue;
  if (typeof val !== 'string') {
    throw new McpArgError(`${key} must be a string, got ${typeof val}`);
  }
  return val;
}

/** Extract a required number argument. Throws McpArgError if missing or wrong type. */
export function requireNumber(args: Record<string, unknown>, key: string): number {
  const val = args[key];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new McpArgError(`${key} must be a finite number, got ${val === null ? 'null' : typeof val}`);
  }
  return val;
}

/** Extract an optional number argument. Returns undefined if absent/null, throws if wrong type. */
export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new McpArgError(`${key} must be a number, got ${typeof val}`);
  }
  return val;
}

/** Extract a number argument with a default value. */
export function numberWithDefault(args: Record<string, unknown>, key: string, defaultValue: number): number {
  const val = args[key];
  if (val === undefined || val === null) return defaultValue;
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new McpArgError(`${key} must be a number, got ${typeof val}`);
  }
  return val;
}

/** Extract a required boolean argument. Throws McpArgError if missing or wrong type. */
export function requireBoolean(args: Record<string, unknown>, key: string): boolean {
  const val = args[key];
  if (typeof val !== 'boolean') {
    throw new McpArgError(`${key} must be a boolean, got ${val === null ? 'null' : typeof val}`);
  }
  return val;
}

/** Extract an optional boolean argument. Returns undefined if absent/null, throws if wrong type. */
export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') {
    throw new McpArgError(`${key} must be a boolean, got ${typeof val}`);
  }
  return val;
}

/** Extract a boolean argument with a default value. */
export function booleanWithDefault(args: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
  const val = args[key];
  if (val === undefined || val === null) return defaultValue;
  if (typeof val !== 'boolean') {
    throw new McpArgError(`${key} must be a boolean, got ${typeof val}`);
  }
  return val;
}
