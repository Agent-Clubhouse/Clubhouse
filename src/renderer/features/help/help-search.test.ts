import { describe, it, expect } from 'vitest';
import { searchHelpTopics } from './help-search';
import type { HelpSection } from './help-content';

const TEST_SECTIONS: HelpSection[] = [
  {
    id: 'general',
    title: 'General',
    topics: [
      { id: 'getting-started', title: 'Getting Started', content: '# Getting Started\n\nWelcome to Clubhouse. This guide helps you get up and running.' },
      { id: 'keyboard-shortcuts', title: 'Keyboard Shortcuts', content: '# Keyboard Shortcuts\n\nPress **Cmd+K** to open the command palette.' },
      { id: 'dashboard', title: 'Dashboard', content: '# Dashboard\n\nThe dashboard shows your projects and agents.' },
    ],
  },
  {
    id: 'agents',
    title: 'Agents & Orchestrators',
    topics: [
      { id: 'agents-overview', title: 'Agent Overview', content: '# Agent Overview\n\nAgents run in terminal sessions.' },
      { id: 'agents-durable', title: 'Durable Agents', content: '# Durable Agents\n\nDurable agents persist across sessions and can be resumed.' },
    ],
  },
  {
    id: 'plugins',
    title: 'Plugins',
    topics: [
      { id: 'plugins-overview', title: 'Installing & Using Plugins', content: '# Plugins\n\nPlugins extend Clubhouse with custom functionality.' },
    ],
  },
];

describe('searchHelpTopics', () => {
  it('returns empty array for empty query', () => {
    expect(searchHelpTopics(TEST_SECTIONS, '')).toEqual([]);
    expect(searchHelpTopics(TEST_SECTIONS, '   ')).toEqual([]);
  });

  it('matches topic titles', () => {
    const results = searchHelpTopics(TEST_SECTIONS, 'keyboard');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].topic.id).toBe('keyboard-shortcuts');
  });

  it('matches content when title does not match', () => {
    const results = searchHelpTopics(TEST_SECTIONS, 'command palette');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.topic.id === 'keyboard-shortcuts')).toBe(true);
  });

  it('title matches score higher than content-only matches', () => {
    // "agent" appears in the title of agents-overview and agents-durable,
    // and also in content of dashboard ("projects and agents")
    const results = searchHelpTopics(TEST_SECTIONS, 'agent');
    const titleMatches = results.filter((r) => r.topic.title.toLowerCase().includes('agent'));
    const contentOnlyMatches = results.filter((r) => !r.topic.title.toLowerCase().includes('agent'));

    if (titleMatches.length > 0 && contentOnlyMatches.length > 0) {
      expect(titleMatches[0].score).toBeGreaterThan(contentOnlyMatches[0].score);
    }
  });

  it('returns section info with each result', () => {
    const results = searchHelpTopics(TEST_SECTIONS, 'durable');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const durableResult = results.find((r) => r.topic.id === 'agents-durable');
    expect(durableResult).toBeDefined();
    expect(durableResult!.sectionId).toBe('agents');
    expect(durableResult!.sectionTitle).toBe('Agents & Orchestrators');
  });

  it('provides a snippet for content matches', () => {
    const results = searchHelpTopics(TEST_SECTIONS, 'command palette');
    const match = results.find((r) => r.topic.id === 'keyboard-shortcuts');
    expect(match).toBeDefined();
    expect(match!.snippet).toBeTruthy();
    expect(match!.snippet!.toLowerCase()).toContain('command palette');
  });

  it('returns results sorted by score descending', () => {
    const results = searchHelpTopics(TEST_SECTIONS, 'agent');
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('matches across multiple sections', () => {
    // "agents" appears in agent section titles and dashboard content ("projects and agents")
    const results = searchHelpTopics(TEST_SECTIONS, 'agents');
    const sectionIds = new Set(results.map((r) => r.sectionId));
    expect(sectionIds.size).toBeGreaterThanOrEqual(2);
  });

  it('prefix match in title scores higher', () => {
    const results = searchHelpTopics(TEST_SECTIONS, 'getting');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].topic.id).toBe('getting-started');
    expect(results[0].score).toBeGreaterThan(100); // 100 base + 20 prefix
  });

  it('is case insensitive', () => {
    const lower = searchHelpTopics(TEST_SECTIONS, 'dashboard');
    const upper = searchHelpTopics(TEST_SECTIONS, 'DASHBOARD');
    expect(lower.length).toBe(upper.length);
    expect(lower[0].topic.id).toBe(upper[0].topic.id);
  });

  it('returns no results for non-matching query', () => {
    const results = searchHelpTopics(TEST_SECTIONS, 'xyznonexistent');
    expect(results).toEqual([]);
  });

  it('strips markdown formatting when searching content', () => {
    const sections: HelpSection[] = [
      {
        id: 'test',
        title: 'Test',
        topics: [
          { id: 't1', title: 'Bold Test', content: 'Use **bold text** for emphasis.' },
        ],
      },
    ];
    const results = searchHelpTopics(sections, 'bold text');
    expect(results.length).toBe(1);
  });
});
