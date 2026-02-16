import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('voice-chat plugin manifest', () => {
  it('passes manifest validation', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('has correct id', () => {
    expect(manifest.id).toBe('voice-chat');
  });

  it('is project-scoped', () => {
    expect(manifest.scope).toBe('project');
  });

  it('targets API v0.5', () => {
    expect(manifest.engine.api).toBe(0.5);
  });

  it('declares voice, agents, notifications permissions', () => {
    expect(manifest.permissions).toEqual(['voice', 'agents', 'notifications']);
  });

  it('contributes help topics', () => {
    expect(manifest.contributes?.help).toBeDefined();
    expect(manifest.contributes!.help!.topics).toBeDefined();
    expect(manifest.contributes!.help!.topics!.length).toBeGreaterThan(0);
  });

  it('contributes two help topics (usage + troubleshooting)', () => {
    const topics = manifest.contributes!.help!.topics!;
    expect(topics).toHaveLength(2);
    expect(topics[0].id).toBe('voice-chat');
    expect(topics[1].id).toBe('voice-chat-troubleshooting');
  });

  it('contributes a sidebar-content layout tab', () => {
    expect(manifest.contributes?.tab).toBeDefined();
    expect(manifest.contributes!.tab!.layout).toBe('sidebar-content');
    expect(manifest.contributes!.tab!.label).toBe('Voice');
  });

  it('has a tab icon (SVG string)', () => {
    expect(manifest.contributes!.tab!.icon).toContain('<svg');
  });

  it('does not contribute a rail item (project-scoped only)', () => {
    expect(manifest.contributes?.railItem).toBeUndefined();
  });

  it('does not contribute commands', () => {
    expect(manifest.contributes?.commands).toBeUndefined();
  });

  it('does not contribute settings', () => {
    expect(manifest.contributes?.settings).toBeUndefined();
  });
});
