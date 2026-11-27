import { describe, it, expect, afterEach } from 'vitest';
import { HELP_SECTIONS, CHROME_HELP_SECTIONS, DISPATCHER_TOPIC, GROUP_PROJECT_TOPICS, NEW_LAYOUT_TOPICS, getHelpSections } from './help-content';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { PREPARE_HANDOFF_SKILL_MD } from '../../../shared/prepare-handoff-skill';

describe('help-content', () => {
  it('has 6 sections', () => {
    expect(HELP_SECTIONS).toHaveLength(6);
  });

  it('has the expected section IDs in order', () => {
    const ids = HELP_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(['general', 'projects', 'agents', 'plugins', 'settings', 'troubleshooting']);
  });

  it('has 27 total topics', () => {
    const total = HELP_SECTIONS.reduce((sum, s) => sum + s.topics.length, 0);
    expect(total).toBe(27);
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

  it('Agents & Orchestrators section has 10 topics', () => {
    const agents = HELP_SECTIONS.find((s) => s.id === 'agents');
    expect(agents?.topics).toHaveLength(10);
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
      for (const [sections, title] of [[HELP_SECTIONS, 'Orchestrated Helpers'], [CHROME_HELP_SECTIONS, 'Helpers and Smart routing']] as const) {
        const agents = sections.find((s) => s.id === 'agents')!.topics.map((t) => t.id);
        expect(agents.indexOf('agents-orchestrated-helpers')).toBe(agents.indexOf('agents-terminal') + 1);
        expect(find(sections, 'agents-orchestrated-helpers').title).toBe(title);
      }
    });

    it('covers the cards, access, control, limits, deleting and connections', () => {
      const content = find(HELP_SECTIONS, 'agents-orchestrated-helpers').content;
      expect(content).toContain('**Let this agent orchestrate**');
      for (const name of ['**Orchestration**', '**Helpers**', '**Connections**', 'the **Helpers** page in Settings', '**Delete anyway**', '**Needs you**']) {
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
    expect(find('projects-settings').content).toContain('**Runs on**');
  });
});

describe('Antigravity CLI help (#3801)', () => {
  const find = (sections: typeof HELP_SECTIONS) => sections.flatMap((s) => s.topics).find((t) => t.id === 'agents-antigravity')!;

  it('follows Agents & CLIs in both shells', () => {
    for (const sections of [HELP_SECTIONS, CHROME_HELP_SECTIONS]) {
      const agents = sections.find((s) => s.id === 'agents')!.topics.map((t) => t.id);
      expect(agents.indexOf('agents-antigravity')).toBe(agents.indexOf('orchestrators') + 1);
      expect(find(sections).title).toBe('Antigravity CLI');
    }
  });

  it('gives the install link, sign-in routes, trust prompt, headless limit and API key steps', () => {
    const content = find(HELP_SECTIONS).content;
    for (const part of [
      'https://antigravity.google/docs/getting-started/', 'agy --version', 'agy acp --login', 'asks whether you trust that folder',
      '`agy -p`', 'not supported under consumer plans', 'not available for business or enterprise accounts',
      '"modelProvider": "gemini"', '`GEMINI_API_KEY`', '~/.gemini/antigravity-cli/log/acp-*.log', '~/.gemini', 'AGY_CLI_DISABLE_AUTO_UPDATE',
    ]) expect(content, part).toContain(part);
  });

  it('states both documented eligibility statements and the model discrepancy without a verdict', () => {
    const content = find(HELP_SECTIONS).content;
    expect(content).toContain('https://antigravity.google/docs/faq/');
    expect(content).toContain('https://antigravity.google/docs/ide/extensions/acp/');
    expect(content).toContain('2026-11-23');
    expect(content).toContain('Clubhouse does not decide which one covers you');
    // Paraphrase, not copied passages: at most one short quoted phrase.
    expect(content).not.toMatch(/^>/m);
    const quoted = [...content.replace(/`[^`]*`/g, '').matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(' ');
    expect(quoted.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(25);
    expect(content).toContain('1.5.1 changelog');
    // No promise about plans, models or quotas.
    expect(content).not.toMatch(/\b(is|are) (allowed|permitted|supported on)\b|guarantee/i);
  });

  it('names only the workspace files Clubhouse writes and never writes to ~/.gemini', () => {
    const content = find(HELP_SECTIONS).content;
    for (const file of ['`AGENTS.md`', '`.agents/skills/`', '`.agents/mcp_config.json`', '`.agents/hooks.json`']) expect(content, file).toContain(file);
    expect(content).toContain('Clubhouse never writes to `~/.gemini`');
    expect(content).toContain('never reads, copies or stores your Antigravity credentials');
  });

  it('follows the copy rules and points only at pages that exist', () => {
    const content = find(HELP_SECTIONS).content;
    expect(content).not.toContain('\u2014');
    expect(content).not.toMatch(/[A-Z]{4,} [A-Z]{4,}/);
    expect(content).toContain('**Settings > Agents & CLIs**');
    expect(content).toContain('**Antigravity CLI** in **Settings > Experimental**');
    expect(content).not.toContain('antigravityProvider');
    expect(content).not.toMatch(/\b(orchestrator|persona)\b/i);
  });

  it('is a row and a column in the provider matrix', () => {
    const matrix = find(HELP_SECTIONS) && HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === 'orchestrators')!.content;
    expect(matrix).toContain('| **Antigravity CLI** |');
    expect(matrix).toContain('| Hooks | Yes | Yes | Yes | Yes on macOS and Linux, no on Windows |');
    expect(matrix).toMatch(/\| Capability \| Claude Code \| Copilot CLI \| Codex CLI \| Antigravity CLI \|/);
  });
});

describe('help-content in the new shell', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));

  const topics = () => CHROME_HELP_SECTIONS.flatMap((s) => s.topics);
  // Personas are prompts, not descriptions of the app.
  const articles = () => [...CHROME_HELP_SECTIONS.filter((s) => !['personas'].includes(s.id)).flatMap((s) => s.topics), DISPATCHER_TOPIC, ...NEW_LAYOUT_TOPICS.map((n) => n.topic)];
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
      for (const t of [...s.topics, ...NEW_LAYOUT_TOPICS.map((n) => n.topic)]) {
        expect(t.title, t.title).not.toMatch(/ & |\s(?!Git\b|CLI\b|PR\b|UI\b|QA\b|A\/B\b|Clubhouse\b|Smart routing\b)\(?[A-Z][a-z]/);
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
    const pages = ['About', 'Agents & CLIs', 'Managed agents', 'Helpers', 'Smart routing', 'Actions', 'Dispatcher', 'Display & UI', 'External editor', 'Keyboard shortcuts',
      'Notifications & alerts', 'Experimental', 'Plugins', 'Annex', 'Annex Network', 'Annex control', 'Usage', 'Updates', 'Logging', 'Feedback', 'Group Projects', "What's new"];
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

  it('offers searchable group project help and glossary in the new shell', () => {
    useChromeFlagStore.setState({ enabled: true });
    const topics = getHelpSections().flatMap((s) => s.topics);
    for (const topic of GROUP_PROJECT_TOPICS) expect(topics).toContain(topic);
    expect(GROUP_PROJECT_TOPICS[0].content).toContain('Existing groups move to notices automatically');
    expect(GROUP_PROJECT_TOPICS[1].content).toContain('Group project admin');
    for (const topic of GROUP_PROJECT_TOPICS) expect(topic.content).not.toContain('—');
  });

  it('describes the Group Projects entry, Board, hosts, membership and roster that shipped (#3552)', () => {
    const content = GROUP_PROJECT_TOPICS[0].content;
    for (const part of [
      'only the selected one shows its label', 'All groups', 'lands on its **Board**', 'Start with every agent in', 'Include linked computers',
      'never added automatically', 'explicit project link', 'Offer to link', 'Coverage not verified on this computer', 'Needs you',
      'Waiting for approval', 'Members on this computer', 'On this computer', '**Applied** means that computer made it', '**Refused** gives that computer', 'stops only agents on linked computers', 'while its Dispatcher is off',
      'made by an earlier version keeps its earlier matching', 'still matches other computers\' projects by repository key', 'a phone paired with that computer',
    ]) expect(content, part).toContain(part);
    expect(content).not.toMatch(/[A-Z]{4,} [A-Z]{4,}/);
    // No sentence may say all network groups match by repository key, or that any phone in the network approves.
    expect(content).not.toContain('a phone in your network');
    expect(content).not.toContain('Clubhouse matches projects by their repository key');
  });

  it('describes what the Dispatcher does today, in plain words (#3053)', () => {
    const content = DISPATCHER_TOPIC.content;
    for (const part of [
      'on by default', 'Set up later', 'Try it out', 'What else can you do?', 'in the Dispatcher\'s words', 'Check-ins', 'Start new chat', 'Restart Dispatcher', 'Restart, keep chat', 'Restart and start new chat',
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
    expect(settingsIds(getHelpSections())).toEqual(['settings-themes', 'settings-sound', 'settings-notifications', 'settings-annex', 'settings-logging', 'settings-privacy']);
    // Only the new shell's sections get it: the classic articles are left as they were.
    expect(settingsIds(CHROME_HELP_SECTIONS)).not.toContain('settings-annex');
  });
});

describe('Handoffs help (#3344)', () => {
  it('is in both layouts and names the prepare-handoff skill and who gets it', () => {
    for (const sections of [HELP_SECTIONS, CHROME_HELP_SECTIONS]) {
      const topic = sections.flatMap((s) => s.topics).find((t) => t.id === 'agents-handoffs');
      expect(topic?.content).toContain('prepare-handoff');
      expect(topic?.content).toContain('Offer handoffs');
      // It links the skill's own topic, which shows the exact text agents get.
      expect(topic?.content).toContain('](#help:agents-prepare-handoff)');
      const skill = sections.flatMap((s) => s.topics).find((t) => t.id === 'agents-prepare-handoff');
      expect(skill?.content).toContain(PREPARE_HANDOFF_SKILL_MD.trimEnd());
    }
  });
});

describe('1.0 pages in the new layout (#3902)', () => {
  afterEach(() => useChromeFlagStore.setState({ enabled: false }));
  const topic = (id: string) => NEW_LAYOUT_TOPICS.find((n) => n.topic.id === id)!.topic;
  const LINK = /\]\(#help:([a-z0-9-]+)\)/g;

  it('places each page after the topic it names, in the new layout only', () => {
    useChromeFlagStore.setState({ enabled: true });
    const all = getHelpSections().flatMap((s) => s.topics.map((t) => t.id));
    for (const { after, topic: t } of NEW_LAYOUT_TOPICS) {
      expect(all, t.id).toContain(after);
      expect(all.indexOf(t.id), t.id).toBeGreaterThan(all.indexOf(after));
    }
    expect(new Set(all).size).toBe(all.length);
    const classic = HELP_SECTIONS.flatMap((s) => s.topics.map((t) => t.id));
    for (const { topic: t } of NEW_LAYOUT_TOPICS) expect(classic, t.id).not.toContain(t.id);
  });

  it('follows the copy rules and links only to topics that exist', () => {
    useChromeFlagStore.setState({ enabled: true });
    const ids = new Set(getHelpSections().flatMap((s) => s.topics.map((t) => t.id)));
    for (const { topic: t } of NEW_LAYOUT_TOPICS) {
      expect(t.content, t.id).not.toContain('\u2014');
      expect(t.content, t.id).not.toMatch(/[A-Z]{4,} [A-Z]{4,}/);
      expect(t.content, t.id).not.toMatch(/\b(dispose|disposing|wires?)\b/i);
      for (const m of t.content.matchAll(LINK)) expect(ids.has(m[1]), `${t.id} links ${m[1]}`).toBe(true);
    }
  });

  describe('Managed agents (#3894)', () => {
    it('follows Agents in the agents section', () => {
      useChromeFlagStore.setState({ enabled: true });
      const agents = getHelpSections().find((s) => s.id === 'agents')!.topics.map((t) => t.id);
      expect(agents.indexOf('agents-managed')).toBe(agents.indexOf('agents-chat') + 1);
      expect(topic('agents-managed').title).toBe('Managed agents');
    });

    it('says how instructions are joined and which wildcards are filled', () => {
      const content = topic('agents-managed').content;
      expect(content).toContain('with a blank line between each one, and adds no text of its own');
      for (const w of ['`@@AgentName`', '`@@Path`', '`@@StandbyBranch`']) expect(content, w).toContain(w);
      expect(content).toContain('Any other `@@` word stays as you wrote it');
      expect(content).toContain('**Show wildcards**');
    });

    it('lists the files each CLI reads its setup from', () => {
      const content = topic('agents-managed').content;
      for (const row of [
        '| Claude Code | `CLAUDE.md` | `.claude/skills/` | `.mcp.json` |',
        '| Codex CLI | `AGENTS.md` | `.agents/skills/` | Given to Codex when it starts |',
        '| Copilot CLI | `.github/copilot-instructions.md` | `.github/skills/` | `.github/mcp.json` |',
        '| Antigravity CLI | `AGENTS.md` | `.agents/skills/` | `.agents/mcp_config.json` |',
      ]) expect(content, row).toContain(row);
    });

    it('covers the save dialog, the Setup changed bar, forking and the library with the labels that ship', () => {
      const content = topic('agents-managed').content;
      for (const label of [
        '**Restart**', '**Save and restart**', 'Restart keeps the conversation', '**Keep mine**', '**Take theirs**', '**What changed**',
        '**Fork**', '**Back to shared**', '"Coding standards, reviewer"', '**Make your copy**', '**Show parts used by one agent**',
        '**Give each agent its own copy**', '**Remove it from those agents**', '**Save template only**', '**Save as template**',
        '**Start with template**', '**Build from scratch**', '**Copy another agent**', '**Switch to plain**', '**Switch to managed**',
        '`.clubhouse/parts/`', 'Clubhouse stores no secrets',
      ]) expect(content, label).toContain(label);
    });
  });
});
