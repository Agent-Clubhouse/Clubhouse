import { describe, it, expect, afterEach } from 'vitest';
import { NEW_LAYOUT_TOPICS, getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

describe('privacy-classic help in the new layout', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));
  const topic = (id: string) => NEW_LAYOUT_TOPICS.find((n) => n.topic.id === id)!.topic;

  describe('Coming from classic (#3899)', () => {
    it('follows Keyboard shortcuts in General', () => {
      useChromeFlagStore.setState({ enabled: true });
      const general = getHelpSections().find((s) => s.id === 'general')!.topics.map((t) => t.id);
      expect(general.indexOf('coming-from-classic')).toBe(general.indexOf('keyboard-shortcuts') + 1);
    });

    it('says what moved, what went and what happened to its data', () => {
      const content = topic('coming-from-classic').content;
      for (const part of [
        '**Free Agent Mode**', 'Off became Ask first, and on became Auto or Full access', '**Settings > Agents & CLIs**', '**Settings > Annex Network**',
        'Removed, with their data. Files git tracks in a project', 'Your old profiles file is kept as it was', 'API 0.7, 0.8 or 0.9',
        "**Copy this project's legacy defaults**", '**Classic layout**', '**Settings > Display & UI**', 'will go away in a future update',
      ]) expect(content, part).toContain(part);
    });
  });

  describe('Privacy and diagnostics (#3900)', () => {
    it('follows Logging and diagnostics in Settings', () => {
      useChromeFlagStore.setState({ enabled: true });
      const settings = getHelpSections().find((s) => s.id === 'settings')!.topics.map((t) => t.id);
      expect(settings.indexOf('settings-privacy')).toBe(settings.indexOf('settings-logging') + 1);
    });

    it('covers the local record, export, history, feedback reports and the developer switch', () => {
      const content = topic('settings-privacy').content;
      for (const part of [
        '`~/.clubhouse/logs`', '**Record locally**', 'never the value', '**Telemetry export**', 'Every destination is off until you set it up',
        '**Learn what\'s sent**', '**Preview data**', '**Not now**', '**Reset telemetry ID**', '**Delete local telemetry data**',
        '**Include recent diagnostics**', '**Send without screenshot**', '**Held reports**', '**Telemetry for the developer**',
      ]) expect(content, part).toContain(part);
      // Internal service names stay out of user text.
      expect(content).not.toMatch(/framebriar|workshop|backfill/i);
    });
  });
});
