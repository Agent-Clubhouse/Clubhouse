import { describe, it, expect } from 'vitest';
import { HELP_SECTIONS } from './help-content';

describe('help-content', () => {
  it('has 6 sections', () => {
    expect(HELP_SECTIONS).toHaveLength(6);
  });

  it('has the expected section IDs in order', () => {
    const ids = HELP_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(['general', 'projects', 'agents', 'plugins', 'settings', 'troubleshooting']);
  });

  it('has 26 total topics', () => {
    const total = HELP_SECTIONS.reduce((sum, s) => sum + s.topics.length, 0);
    expect(total).toBe(26);
  });

  it('each section has at least 1 topic', () => {
    for (const section of HELP_SECTIONS) {
      expect(section.topics.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('all topic IDs are unique', () => {
    const ids = HELP_SECTIONS.flatMap((s) => s.topics.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all section IDs are unique', () => {
    const ids = HELP_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all topics have non-empty content', () => {
    for (const section of HELP_SECTIONS) {
      for (const topic of section.topics) {
        expect(topic.content.length).toBeGreaterThan(0);
      }
    }
  });

  it('General section has 7 topics', () => {
    const general = HELP_SECTIONS.find((s) => s.id === 'general');
    expect(general?.topics).toHaveLength(7);
  });

  it('Agents & Orchestrators section has 6 topics', () => {
    const agents = HELP_SECTIONS.find((s) => s.id === 'agents');
    expect(agents?.topics).toHaveLength(6);
  });

  it('Settings section has 5 topics', () => {
    const settings = HELP_SECTIONS.find((s) => s.id === 'settings');
    expect(settings?.topics).toHaveLength(5);
  });

  it('includes key new topics', () => {
    const allTopicIds = HELP_SECTIONS.flatMap((s) => s.topics.map((t) => t.id));
    expect(allTopicIds).toContain('command-palette');
    expect(allTopicIds).toContain('hub');
    expect(allTopicIds).toContain('dashboard');
    expect(allTopicIds).toContain('agents-clubhouse-mode');
    expect(allTopicIds).toContain('settings-sound');
    expect(allTopicIds).toContain('settings-annex');
    expect(allTopicIds).toContain('orchestrators');
  });
});
