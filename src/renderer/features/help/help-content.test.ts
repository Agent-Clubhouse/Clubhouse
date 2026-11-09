import { describe, it, expect, afterEach } from 'vitest';
import { HELP_SECTIONS, CHROME_HELP_SECTIONS, DISPATCHER_TOPIC, getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

describe('help-content', () => {
  it('has 6 sections', () => {
    expect(HELP_SECTIONS).toHaveLength(6);
  });

  it('has the expected section IDs in order', () => {
    const ids = HELP_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(['general', 'projects', 'agents', 'plugins', 'settings', 'troubleshooting']);
  });

  it('has 24 total topics', () => {
    const total = HELP_SECTIONS.reduce((sum, s) => sum + s.topics.length, 0);
    expect(total).toBe(24);
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

  it('General section has 5 topics', () => {
    const general = HELP_SECTIONS.find((s) => s.id === 'general');
    expect(general?.topics).toHaveLength(5);
  });

  it('Agents & Orchestrators section has 7 topics', () => {
    const agents = HELP_SECTIONS.find((s) => s.id === 'agents');
    expect(agents?.topics).toHaveLength(7);
  });

  it('Settings section has 4 topics', () => {
    const settings = HELP_SECTIONS.find((s) => s.id === 'settings');
    expect(settings?.topics).toHaveLength(4);
  });

  it('no classic article points at the removed Home or Dashboard', () => {
    for (const t of HELP_SECTIONS.flatMap((s) => s.topics)) {
      expect(t.content, t.id).not.toMatch(/Dashboard|Go (to )?home|Cmd\+Shift\+H/i);
    }
  });

  it('includes key new topics', () => {
    const allTopicIds = HELP_SECTIONS.flatMap((s) => s.topics.map((t) => t.id));
    expect(allTopicIds).toContain('command-palette');
    expect(allTopicIds).not.toContain('hub');
    // Home and its Dashboard topic were removed for v1.
    expect(allTopicIds).not.toContain('dashboard');
    // Clubhouse Mode and personas left Help when Clubhouse-managed agents graduated (#2901).
    expect(allTopicIds).not.toContain('agents-clubhouse-mode');
    expect(allTopicIds.some((id) => id.startsWith('persona-'))).toBe(false);
    expect(allTopicIds).toContain('settings-sound');
    expect(allTopicIds).toContain('orchestrators');
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
      for (const name of ['**Orchestration**', '**Helpers**', '**Connections**', '**Settings > Managed agents > Helpers**', '**Dispose anyway**', '**Needs you**']) {
        expect(content, name).toContain(name);
      }
      for (const heading of ['## Access', '## Control levels', '## Limits', '## Disposing', '## Connections']) {
        expect(content).toContain(heading);
      }
      for (const tool of [
        'start_helper', 'list_helpers', 'sleep_helper', 'wake_helper', 'message_parent', 'answer_helper_question', 'hand_off', 'dispose_helper',
        'create_group_project', 'add_to_group_project', 'remove_from_group_project', 'connect_agents', 'disconnect_agents',
        'list_projects', 'list_models',
      ]) {
        expect(content, tool).toContain(`\`${tool}\``);
      }
    });

    it('covers helpers in other projects (#2515)', () => {
      const content = find(HELP_SECTIONS, 'agents-orchestrated-helpers').content;
      expect(content).toContain('## Helpers in other projects');
      expect(content).toContain('**Cross-project helpers**');
      expect(content).toContain('`project`');
      expect(content).toContain('| `crossProjectHelpers` |');
      expect(content).toMatch(/older version of Clubhouse/);
    });

    it('covers the Connect to Dispatcher switch (#2534)', () => {
      const content = find(HELP_SECTIONS, 'agents-orchestrated-helpers').content;
      expect(content).toContain('**Connect to Dispatcher**');
      expect(content).toContain('| `connectToDispatcher` |');
    });

    it('covers the Dispatcher card in details (#3049)', () => {
      const content = find(HELP_SECTIONS, 'agents-orchestrated-helpers').content;
      expect(content).toContain('Asking what it does…');
      expect(content).toContain('**When to reach it**');
      expect(content).toContain('**Undo**');
    });

    it('keeps the new copy free of em dashes', () => {
      for (const id of ['agents-orchestrated-helpers']) {
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
  // Personas are prompts, not descriptions of the app.
  const articles = () => [...CHROME_HELP_SECTIONS.filter((s) => !['personas'].includes(s.id)).flatMap((s) => s.topics), DISPATCHER_TOPIC];
  // Articles written for the classic layout that the new shell replaces.
  const RETIRED = /Project Rail|Explorer Rail|Accessory Panel|Dashboard|Home icon|Cmd\+Shift\+H|ghost card/i;

  it('getHelpSections follows the shell flag', () => {
    expect(getHelpSections()).toBe(HELP_SECTIONS);
    useChromeFlagStore.setState({ enabled: true });
    expect(getHelpSections().map((s) => s.id)).toEqual(CHROME_HELP_SECTIONS.map((s) => s.id));
  });

  it('keeps the classic section ids, with no Dashboard in either shell', () => {
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
    const pages = ['About', 'Agents & providers', 'Managed agents', 'Helpers', 'Smart selection', 'Actions', 'Dispatcher', 'Display & UI', 'External editor', 'Keyboard shortcuts',
      'Notifications & alerts', 'Plugins', 'Annex', 'Annex control', 'Updates', 'Logging', 'Feedback', "What's new"];
    for (const t of articles()) {
      for (const m of t.content.matchAll(/\*\*Settings > ([^*]+)\*\*/g)) {
        const page = m[1].split(' > ')[0];
        expect(pages.map((p) => p.toLowerCase()), `${t.id}: ${m[1]}`).toContain(page.toLowerCase());
      }
    }
  });

  it('lists the Dispatcher after Orchestrated helpers in the new shell only (#3053)', () => {
    useChromeFlagStore.setState({ enabled: true });
    const agentIds = (sections: typeof HELP_SECTIONS) => sections.find((s) => s.id === 'agents')!.topics.map((t) => t.id);
    const ids = agentIds(getHelpSections());
    expect(ids.indexOf('agents-dispatcher')).toBe(ids.indexOf('agents-orchestrated-helpers') + 1);
    expect(agentIds(HELP_SECTIONS)).not.toContain('agents-dispatcher');
    expect(DISPATCHER_TOPIC.title).toBe('Dispatcher');
  });

  it('describes what the Dispatcher does today, in plain words (#3053)', () => {
    const content = DISPATCHER_TOPIC.content;
    for (const part of [
      'on by default', 'Set up later', 'Try it out', 'What else can you do?', 'group chat', 'Check-ins', 'Clear chat',
      'wakes it', '| Light | Standard | Thorough |', '~/.clubhouse/dispatcher/memory/', 'Forget everything', 'Dispatcher card',
      'Asking what it does…', 'tell me when main is pushed', 'adds or opens a project', 'Needs you', 'Runs on',
      'conversations and background work', 'On your phone',
    ]) expect(content, part).toContain(part);
    // One identity: no text names a second session or how the work is split.
    expect(content).not.toMatch(/\bcoordinators?\b|\b(?:second|hidden|background|two|other) (?:agent )?sessions?\b|\bphone ?book\b/i);
    expect(content).not.toMatch(/\u2014/);
  });

  it('lists Annex under Settings on every build, since Annex is stable (#2811)', () => {
    useChromeFlagStore.setState({ enabled: true });
    const settingsIds = (sections: typeof HELP_SECTIONS) => sections.find((s) => s.id === 'settings')!.topics.map((t) => t.id);
    expect(settingsIds(getHelpSections())).toEqual(['settings-themes', 'settings-sound', 'settings-notifications', 'settings-annex', 'settings-logging']);
    // Only the new shell's sections get it: the classic articles are left as they were.
    expect(settingsIds(CHROME_HELP_SECTIONS)).not.toContain('settings-annex');
  });
});
