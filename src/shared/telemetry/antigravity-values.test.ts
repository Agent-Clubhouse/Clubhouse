import { describe, expect, it } from 'vitest';
import { ANTIGRAVITY_CHAT_DRIVER_ID, ANTIGRAVITY_PROVIDER_ID } from '../providers/antigravity';
import { PROVIDER_TELEMETRY_CODES, providerTelemetryCode } from '../providers/descriptors';
import { CHAT_DRIVER_IDS } from '../chat/capabilities';
import { ATTR, OTHER, allAttributeKeys, getAttributeSpec } from './attributes';

/**
 * Antigravity telemetry values (#3800). The exporter's enums are closed, so
 * the provider and its chat driver are reviewed additions to two existing
 * attributes. They add no attribute of their own, and the existing values
 * stay exactly as they were.
 */
describe('Antigravity telemetry values', () => {
  it('reports the provider as antigravity-cli on every attribute that carries a provider', () => {
    expect(ATTR.orchestrator(ANTIGRAVITY_PROVIDER_ID).value).toBe('antigravity-cli');
    expect(ATTR.helperRoutingRequestedCli(ANTIGRAVITY_PROVIDER_ID).value).toBe('antigravity-cli');
    expect(ATTR.helperAskerCli(ANTIGRAVITY_PROVIDER_ID).value).toBe('antigravity-cli');
    expect(providerTelemetryCode(ANTIGRAVITY_PROVIDER_ID)).toBe('antigravity-cli');
  });

  it('reports the chat driver as antigravity_acp', () => {
    expect(ATTR.chatDriver(ANTIGRAVITY_CHAT_DRIVER_ID).value).toBe('antigravity_acp');
  });

  it('keeps every existing value and adds only the two reviewed ones', () => {
    expect(getAttributeSpec('clubhouse.orchestrator')?.values).toEqual(['claude-code', 'codex-cli', 'copilot-cli', 'antigravity-cli', 'other']);
    expect(getAttributeSpec('clubhouse.chat.driver')?.values).toEqual(['claude_agent_sdk', 'claude_stream_json', 'codex_app_server', 'copilot_sdk', 'antigravity_acp']);
    expect(PROVIDER_TELEMETRY_CODES).toEqual(['claude-code', 'codex-cli', 'copilot-cli', 'antigravity-cli']);
  });

  it('lists the same chat drivers as the chat runtime, so neither is added without the other', () => {
    expect(getAttributeSpec('clubhouse.chat.driver')?.values).toEqual([...CHAT_DRIVER_IDS]);
  });

  it('sends anything else about Antigravity as other, never as the raw text', () => {
    for (const raw of ['agy', 'Antigravity CLI', 'antigravity_cli', 'antigravity-acp', 'oauth-personal']) {
      expect(ATTR.orchestrator(raw as 'other').value).toBe(OTHER);
      expect(ATTR.chatDriver(raw as 'copilot_sdk').value).toBe(OTHER);
      expect(providerTelemetryCode(raw)).toBe(OTHER);
    }
  });

  it('adds no attribute of its own', () => {
    expect(allAttributeKeys().filter((k) => /antigravity|\bagy\b|gemini/i.test(k))).toEqual([]);
  });
});
