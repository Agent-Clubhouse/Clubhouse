import { describe, it, expect } from 'vitest';
import { getPluginHelpTopics } from './plugin-help';
import type { PluginManifest } from '../../../shared/plugin-types';

describe('plugin-help', () => {
  const baseManifest: PluginManifest = {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.2.3',
    author: 'Test Author',
    engine: { api: 0.5 },
    scope: 'project',
    permissions: [],
    contributes: { help: {} },
  };

  it('always returns About as the first topic', () => {
    const topics = getPluginHelpTopics(baseManifest);
    expect(topics.length).toBeGreaterThanOrEqual(1);
    expect(topics[0].title).toBe('About');
    expect(topics[0].id).toBe('test-plugin-about');
  });

  it('About contains version', () => {
    const topics = getPluginHelpTopics(baseManifest);
    expect(topics[0].content).toContain('1.2.3');
  });

  it('About contains author', () => {
    const topics = getPluginHelpTopics(baseManifest);
    expect(topics[0].content).toContain('Test Author');
  });

  it('About contains API version', () => {
    const topics = getPluginHelpTopics(baseManifest);
    expect(topics[0].content).toContain('0.5');
  });

  it('About contains scope', () => {
    const topics = getPluginHelpTopics(baseManifest);
    expect(topics[0].content).toContain('project');
  });

  it('custom topics from contributes.help.topics are appended', () => {
    const manifest: PluginManifest = {
      ...baseManifest,
      contributes: {
        help: {
          topics: [
            { id: 'usage', title: 'Usage Guide', content: '# How to use' },
            { id: 'faq', title: 'FAQ', content: '# FAQ' },
          ],
        },
      },
    };
    const topics = getPluginHelpTopics(manifest);
    expect(topics).toHaveLength(3);
    expect(topics[0].title).toBe('About');
    expect(topics[1].title).toBe('Usage Guide');
    expect(topics[1].id).toBe('test-plugin-usage');
    expect(topics[2].title).toBe('FAQ');
    expect(topics[2].id).toBe('test-plugin-faq');
  });

  it('returns only About when no custom topics', () => {
    const topics = getPluginHelpTopics(baseManifest);
    expect(topics).toHaveLength(1);
  });

  it('handles manifest without author', () => {
    const { author, ...noAuthor } = baseManifest;
    const topics = getPluginHelpTopics(noAuthor as PluginManifest);
    expect(topics[0].content).not.toContain('Author');
  });
});
