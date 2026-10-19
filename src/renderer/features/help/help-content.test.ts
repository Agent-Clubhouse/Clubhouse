import { describe, it, expect, afterEach } from 'vitest';
import { HELP_SECTIONS, CHROME_HELP_SECTIONS, getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

describe('help-content', () => {
  it('has 8 sections', () => {
    expect(HELP_SECTIONS).toHaveLength(8);
  });

  it('has the expected section IDs in order', () => {
    const ids = HELP_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(['general', 'projects', 'agents', 'plugins', 'settings', 'troubleshooting', 'personas', 'cookbooks']);
  });

  it('has 41 total topics', () => {
    const total = HELP_SECTIONS.reduce((sum, s) => sum + s.topics.length, 0);
    expect(total).toBe(41);
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
    expect(general?.topics).toHaveLength(6);
  });

  it('Agents & Orchestrators section has 7 topics', () => {
    const agents = HELP_SECTIONS.find((s) => s.id === 'agents');
    expect(agents?.topics).toHaveLength(7);
  });

  it('Settings section has 4 topics', () => {
    const settings = HELP_SECTIONS.find((s) => s.id === 'settings');
    expect(settings?.topics).toHaveLength(4);
  });

  it('includes key new topics', () => {
    const allTopicIds = HELP_SECTIONS.flatMap((s) => s.topics.map((t) => t.id));
    expect(allTopicIds).toContain('command-palette');
    expect(allTopicIds).not.toContain('hub');
    expect(allTopicIds).toContain('dashboard');
    expect(allTopicIds).toContain('agents-clubhouse-mode');
    expect(allTopicIds).toContain('settings-sound');
    expect(allTopicIds).toContain('orchestrators');
  });

  it('Agent Personas section has 11 topics', () => {
    const personas = HELP_SECTIONS.find((s) => s.id === 'personas');
    expect(personas?.topics).toHaveLength(11);
  });

  it('titles persona topics with the current persona names in both shells', () => {
    const titles = (sections: typeof HELP_SECTIONS) =>
      Object.fromEntries(sections.find((s) => s.id === 'personas')!.topics.map((t) => [t.id, t.title]));
    expect(titles(HELP_SECTIONS)).toMatchObject({
      'persona-project-manager': 'Project Manager',
      'persona-qa': 'PR Reviewer',
      'persona-ui-lead': 'Design Lead',
      'persona-quality-auditor': 'AI Slop Detector',
      'persona-executor-pr-only': 'Developer, opens PRs',
      'persona-executor-merge': 'Developer, can merge',
      'persona-doc-updater': 'Docs Writer',
      'persona-judge': 'Solution Judge',
    });
    expect(titles(CHROME_HELP_SECTIONS)).toMatchObject({
      'persona-qa': 'PR reviewer',
      'persona-quality-auditor': 'AI slop detector',
      'persona-executor-pr-only': 'Developer, opens PRs',
      'persona-judge': 'Solution judge',
    });
    const oldNames = /Quality Assurance|Quality Auditor|Executor|Documentation Updater|UI\/Design Lead|Group Project PM/;
    for (const sections of [HELP_SECTIONS, CHROME_HELP_SECTIONS]) {
      for (const topic of sections.flatMap((s) => s.topics).filter((t) => t.id.startsWith('persona-') || t.id.startsWith('cookbook-'))) {
        expect(topic.title, topic.id).not.toMatch(oldNames);
        expect(topic.content, topic.id).not.toMatch(oldNames);
        expect(topic.content, topic.id).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  it('includes all persona topics', () => {
    const allTopicIds = HELP_SECTIONS.flatMap((s) => s.topics.map((t) => t.id));
    expect(allTopicIds).toContain('persona-project-manager');
    expect(allTopicIds).toContain('persona-qa');
    expect(allTopicIds).toContain('persona-quality-auditor');
    expect(allTopicIds).toContain('persona-executor-merge');
    expect(allTopicIds).toContain('persona-doc-updater');
    expect(allTopicIds).toContain('persona-judge');
    expect(allTopicIds).toContain('persona-researcher');
    expect(allTopicIds).toContain('persona-orchestrator');
    expect(allTopicIds).toContain('persona-workhorse');
  });

  describe('orchestrated helpers (#2233)', () => {
    const find = (sections: typeof HELP_SECTIONS, id: string) => sections.flatMap((s) => s.topics).find((t) => t.id === id)!;

    it('has the article after Terminal in both shells', () => {
      for (const [sections, title] of [[HELP_SECTIONS, 'Orchestrated Helpers'], [CHROME_HELP_SECTIONS, 'Orchestrated helpers']] as const) {
        const agents = sections.find((s) => s.id === 'agents')!.topics.map((t) => t.id);
        expect(agents.indexOf('agents-orchestrated-helpers')).toBe(agents.indexOf('agents-terminal') + 1);
        expect(find(sections, 'agents-orchestrated-helpers').title).toBe(title);
      }
    });

    it('covers the cards, access, control, limits, disposing and connections', () => {
      const content = find(HELP_SECTIONS, 'agents-orchestrated-helpers').content;
      expect(content).toContain('**Let this agent orchestrate**');
      for (const name of ['**Orchestrate**', '**Helpers**', '**Connections**', '**Settings > Helpers**', '**Dispose anyway**', '**Needs you**']) {
        expect(content, name).toContain(name);
      }
      for (const heading of ['## Access', '## Control levels', '## Limits', '## Disposing', '## Connections']) {
        expect(content).toContain(heading);
      }
      for (const tool of [
        'start_helper', 'list_helpers', 'sleep_helper', 'wake_helper', 'message_parent', 'hand_off', 'dispose_helper',
        'create_group_project', 'add_to_group_project', 'remove_from_group_project', 'connect_agents', 'disconnect_agents',
      ]) {
        expect(content, tool).toContain(`\`${tool}\``);
      }
    });

    it('shows persona bodies without their settings front-matter', () => {
      for (const sections of [HELP_SECTIONS, CHROME_HELP_SECTIONS]) {
        const orchestrator = find(sections, 'persona-orchestrator').content;
        expect(orchestrator.startsWith('# Orchestrator')).toBe(true);
        expect(orchestrator).not.toContain('orchestration:');
        expect(find(sections, 'persona-workhorse').content.startsWith('# Workhorse')).toBe(true);
      }
    });

    it('keeps the new copy free of em dashes', () => {
      for (const id of ['agents-orchestrated-helpers', 'persona-orchestrator', 'persona-workhorse']) {
        expect(find(HELP_SECTIONS, id).content, id).not.toContain('\u2014');
      }
    });
  });

  it('calls the CLI field "Runs on" where help names it (#2233)', () => {
    const find = (id: string) => CHROME_HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === id)!;
    // "Orchestrator" names a persona, so articles use it in bold only for that.
    const articles = HELP_SECTIONS.concat(CHROME_HELP_SECTIONS).filter((s) => s.id !== 'personas').flatMap((s) => s.topics);
    for (const t of articles) expect(t.content, t.id).not.toMatch(/\*\*(Default )?Orchestrator\*\*(?! persona)/);
    expect(find('agents-durable').content).toContain('**Runs on**');
    expect(find('agents-quick').content).toContain('**Runs on**');
    expect(find('projects-settings').content).toContain('**Agents run on**');
  });
});

describe('help-content in the new shell', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));

  const topics = () => CHROME_HELP_SECTIONS.flatMap((s) => s.topics);
  // Personas and cookbooks are prompts and patterns, not descriptions of the app.
  const articles = () => CHROME_HELP_SECTIONS.filter((s) => !['personas', 'cookbooks'].includes(s.id)).flatMap((s) => s.topics);
  // Articles written for the classic layout that the new shell replaces.
  const RETIRED = /Project Rail|Explorer Rail|Accessory Panel|Dashboard|Home icon|Cmd\+Shift\+H|ghost card/i;

  it('getHelpSections follows the shell flag', () => {
    expect(getHelpSections()).toBe(HELP_SECTIONS);
    useChromeFlagStore.setState({ enabled: true });
    expect(getHelpSections()).toBe(CHROME_HELP_SECTIONS);
  });

  it('keeps the classic section ids and drops Dashboard', () => {
    expect(CHROME_HELP_SECTIONS.map((s) => s.id)).toEqual(HELP_SECTIONS.map((s) => s.id));
    const ids = topics().map((t) => t.id);
    expect(ids).not.toContain('dashboard');
    const classic = new Set(HELP_SECTIONS.flatMap((s) => s.topics.map((t) => t.id)));
    for (const id of ids) expect(classic.has(id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses sentence-case titles', () => {
    for (const s of CHROME_HELP_SECTIONS) {
      expect(s.title).not.toMatch(/&/);
      for (const t of s.topics) {
        expect(t.title, t.title).not.toMatch(/ & |\s(?!Git\b|CLI\b|PR\b|UI\b|QA\b|A\/B\b)\(?[A-Z][a-z]/);
      }
    }
  });

  it('has no articles that describe the classic layout', () => {
    for (const t of articles()) expect(t.content, t.id).not.toMatch(RETIRED);
  });

  it('documents the new shortcut set', () => {
    const shortcuts = topics().find((t) => t.id === 'keyboard-shortcuts')!.content;
    expect(shortcuts).toContain('`⌘2` to `⌘9`');
    expect(shortcuts).toContain('`⌥⌘1` to `⌥⌘9`');
    expect(shortcuts).not.toMatch(/Toggle Accessory|Switch to Project/);
  });

  it('points only at settings pages that exist', () => {
    const pages = ['About', 'Orchestrators & agents', 'Helpers', 'Profiles', 'Display & UI', 'External editor', 'Keyboard shortcuts',
      'Notifications & alerts', 'Plugins', 'Annex', 'Annex control', 'Clubhouse MCP', 'Updates', 'Logging', 'Feedback', "What's new"];
    for (const t of articles()) {
      for (const m of t.content.matchAll(/\*\*Settings > ([^*]+)\*\*/g)) {
        const page = m[1].split(' > ')[0];
        expect(pages.map((p) => p.toLowerCase()), `${t.id}: ${m[1]}`).toContain(page.toLowerCase());
      }
    }
  });

  it('lists Annex under Settings only when asked', () => {
    useChromeFlagStore.setState({ enabled: true });
    const settingsIds = (sections: typeof HELP_SECTIONS) => sections.find((s) => s.id === 'settings')!.topics.map((t) => t.id);
    expect(settingsIds(getHelpSections())).not.toContain('settings-annex');
    expect(settingsIds(getHelpSections({ annex: true }))).toContain('settings-annex');
  });
});
