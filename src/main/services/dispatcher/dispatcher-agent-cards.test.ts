import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../base-dir', () => ({ getBaseDirPath: () => '/nonexistent-base-dir' }));

import type { DurableAgentConfig } from '../../../shared/types';
import {
  AgentCards,
  NO_ANSWER_MS,
  NO_DESCRIPTION,
  NOT_CONNECTED_MESSAGE,
  cardRequestText,
  parseCard,
  renderCard,
  setupSignature,
  type AgentCardDeps,
  type CardDelivery,
} from './dispatcher-agent-cards';
import { AGENT_CARD_PLACEHOLDER, readAgentPage, writeAgentNotes } from './dispatcher-memory';

const PROJECT = '/projects/webapp';
const OTHER = '/projects/api';

let dir: string;
let root: string;
let clock: number;
let state: {
  dispatcherId: string | null;
  projects: Array<{ path: string; name?: string }>;
  agents: Map<string, DurableAgentConfig[]>;
  connected: Set<string>;
  wired: Set<string>;
  running: Set<string>;
  unreadable: Set<string>;
};
let sent: Array<{ agentId: string; text: string }>;
let cards: AgentCards;

function agent(id: string, name: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name, color: 'blue', createdAt: '2026-11-01T00:00:00.000Z', ...extra };
}

function deps(): AgentCardDeps {
  return {
    memoryRoot: root,
    storePath: () => path.join(dir, 'dispatcher-agent-cards.json'),
    activeDispatcherId: () => state.dispatcherId,
    dispatcherName: () => 'Dispatcher',
    isDispatcherPath: (p) => p === '/dispatcher',
    listProjects: async () => state.projects,
    listAgents: async (p) => {
      if (state.unreadable.has(p)) throw new Error('EACCES');
      return state.agents.get(p) ?? [];
    },
    connectedIds: async (_p, agents) => new Set(agents.filter((a) => state.connected.has(a.id)).map((a) => a.id)),
    isWiredToDispatcher: (id) => state.wired.has(id),
    send: async (agentId, text): Promise<CardDelivery> => {
      if (!state.running.has(agentId)) return 'not_running';
      sent.push({ agentId, text });
      return 'delivered';
    },
    log: () => {},
    now: () => clock,
  };
}

/** Connected, wired and running: an agent that can be asked right away. */
function connect(id: string): void {
  state.connected.add(id);
  state.wired.add(id);
  state.running.add(id);
}

function setAgents(projectPath: string, agents: DurableAgentConfig[]): void {
  state.agents.set(projectPath, agents);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cards-'));
  root = path.join(dir, 'memory');
  clock = Date.parse('2026-11-08T12:00:00.000Z');
  state = {
    dispatcherId: 'durable_dispatcher',
    projects: [{ path: PROJECT, name: 'webapp' }, { path: OTHER, name: 'api' }],
    agents: new Map([[PROJECT, [agent('durable_lead', 'lead'), agent('durable_qa', 'qa')]], [OTHER, [agent('durable_api', 'api-lead')]]]),
    connected: new Set(),
    wired: new Set(),
    running: new Set(),
    unreadable: new Set(),
  };
  sent = [];
  cards = new AgentCards(deps());
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the card text', () => {
  it('renders one line per field and reads back the same fields', () => {
    const fields = { purpose: 'Builds the web app.', contactWhen: 'For UI bugs.', owns: 'web/, the design system' };
    const text = renderCard(fields);
    expect(text).toBe('What it\'s for: Builds the web app.\nWhen to reach it: For UI bugs.\nOwns: web/, the design system');
    expect(parseCard(text)).toEqual(fields);
  });

  it('keeps unlabelled lines from a hand edit with what it is for', () => {
    expect(parseCard('Owns: web/\nHandles releases too.')).toEqual({ owns: 'web/', purpose: 'Handles releases too.' });
  });

  it('a setup change is the parts that say what the agent does, not how it runs', () => {
    const base = agent('a', 'a', { managed: { version: 1, blocks: ['b1'], skills: ['s1', 's2'], mcps: [] } });
    expect(setupSignature({ ...base, model: 'opus', effort: 'high', name: 'renamed' })).toBe(setupSignature(base));
    expect(setupSignature({ ...base, managed: { ...base.managed!, skills: ['s2', 's1'] } })).toBe(setupSignature(base));
    expect(setupSignature({ ...base, managed: { ...base.managed!, skills: ['s1'] } })).not.toBe(setupSignature(base));
    expect(setupSignature({ ...base, managed: { ...base.managed!, blocks: ['b1', 'b2'] } })).not.toBe(setupSignature(base));
    expect(setupSignature({ ...base, mission: 'release' })).not.toBe(setupSignature(base));
  });
});

describe('asking on connect', () => {
  it('asks a connected agent once, and gives it a page that says it has no description yet', async () => {
    connect('durable_lead');
    await cards.sync();

    expect(sent).toEqual([{ agentId: 'durable_lead', text: `[Clubhouse] ${cardRequestText('connect', 'Dispatcher')}` }]);
    expect(sent[0].text).toContain('update_my_card');
    const page = await readAgentPage('lead (webapp)', root);
    expect(page).toEqual({ card: AGENT_CARD_PLACEHOLDER, notes: '' });
    expect(await cards.status('durable_lead')).toMatchObject({ state: 'asking', asking: true, page: 'agents/lead-webapp.md', text: NO_DESCRIPTION });

    // Nothing changed: nothing more is asked, also after a restart.
    await cards.sync();
    cards = new AgentCards(deps());
    await cards.sync();
    expect(sent).toHaveLength(1);
  });

  it('asks nobody who is not connected, and nothing while the Dispatcher is off', async () => {
    await cards.sync();
    expect(sent).toEqual([]);
    expect(await cards.status('durable_lead')).toBeNull();

    connect('durable_lead');
    state.dispatcherId = null;
    await cards.sync();
    expect(sent).toEqual([]);
    expect(fs.existsSync(path.join(root, 'agents'))).toBe(false);
  });

  it('never wakes an asleep agent: the request goes after its next turn', async () => {
    connect('durable_lead');
    state.running.delete('durable_lead');
    await cards.sync();
    expect(sent).toEqual([]);
    expect(await cards.status('durable_lead')).toMatchObject({ state: 'none', asking: true, text: NO_DESCRIPTION });

    state.running.add('durable_lead');
    await cards.deliver('durable_lead');
    expect(sent.map((s) => s.agentId)).toEqual(['durable_lead']);
    await cards.deliver('durable_lead');
    expect(sent).toHaveLength(1);
  });

  it('waits for the agent\'s wire to the Dispatcher, so it can answer', async () => {
    connect('durable_lead');
    state.wired.delete('durable_lead');
    await cards.sync();
    expect(sent).toEqual([]);

    state.wired.add('durable_lead');
    await cards.deliver('durable_lead');
    expect(sent.map((s) => s.agentId)).toEqual(['durable_lead']);
  });

  it('reads only the projects asked for, and keeps an unreadable project\'s records', async () => {
    connect('durable_lead');
    connect('durable_api');
    await cards.sync(new Set([PROJECT]));
    expect(sent.map((s) => s.agentId)).toEqual(['durable_lead']);

    state.unreadable.add(PROJECT);
    await cards.sync();
    expect(sent.map((s) => s.agentId)).toEqual(['durable_lead', 'durable_api']);
    expect(await cards.status('durable_lead')).toMatchObject({ asking: true });
  });

  it('gives agents with the same name in one project pages of their own', async () => {
    setAgents(PROJECT, [agent('durable_aaaaaa111111', 'lead'), agent('durable_bbbbbb222222', 'lead')]);
    connect('durable_aaaaaa111111');
    connect('durable_bbbbbb222222');
    await cards.sync();
    const pages = [(await cards.status('durable_aaaaaa111111'))!.page, (await cards.status('durable_bbbbbb222222'))!.page];
    expect(new Set(pages).size).toBe(2);
  });
});

describe('asking on a setup change', () => {
  it('asks again when what the agent does changes, keeping its card until it answers', async () => {
    connect('durable_lead');
    await cards.sync();
    await cards.saveOwnCard('durable_lead', { purpose: 'Leads the web app.', contactWhen: 'For planning.', owns: 'web/' });
    sent = [];

    setAgents(PROJECT, [agent('durable_lead', 'lead', { managed: { version: 1, blocks: [], skills: ['release'], mcps: [] } }), agent('durable_qa', 'qa')]);
    await cards.sync(new Set([PROJECT]));

    expect(sent).toEqual([{ agentId: 'durable_lead', text: `[Clubhouse] ${cardRequestText('setup', 'Dispatcher')}` }]);
    expect(await cards.status('durable_lead')).toMatchObject({ state: 'ready', asking: true, card: { purpose: 'Leads the web app.' } });
  });

  it('asks nothing when only how it runs changes', async () => {
    connect('durable_lead');
    await cards.sync();
    sent = [];
    setAgents(PROJECT, [agent('durable_lead', 'lead', { model: 'opus', effort: 'high' }), agent('durable_qa', 'qa')]);
    await cards.sync();
    expect(sent).toEqual([]);
  });

  it('moves the page when the agent is renamed, keeping the Dispatcher\'s notes, and asks nothing', async () => {
    connect('durable_lead');
    await cards.sync();
    await cards.saveOwnCard('durable_lead', { purpose: 'Leads the web app.' });
    await writeAgentNotes('lead (webapp)', 'Prefers short updates.', root);
    sent = [];

    setAgents(PROJECT, [agent('durable_lead', 'web-lead'), agent('durable_qa', 'qa')]);
    await cards.sync();

    expect(sent).toEqual([]);
    expect(await readAgentPage('lead (webapp)', root)).toBeNull();
    expect(await readAgentPage('web-lead (webapp)', root)).toEqual({ card: 'What it\'s for: Leads the web app.', notes: 'Prefers short updates.' });
    expect((await cards.status('durable_lead'))!.page).toBe('agents/web-lead-webapp.md');
  });
});

describe('turning the connection off and on', () => {
  it('keeps the card while off, and turning it back on asks nothing', async () => {
    connect('durable_lead');
    await cards.sync();
    await cards.saveOwnCard('durable_lead', { purpose: 'Leads the web app.' });
    state.connected.delete('durable_lead');
    await cards.sync();
    expect(await cards.saveOwnCard('durable_lead', { purpose: 'x' })).toEqual({ ok: false, error: NOT_CONNECTED_MESSAGE });

    sent = [];
    state.connected.add('durable_lead');
    await cards.sync();
    expect(sent).toEqual([]);
    expect(await cards.status('durable_lead')).toMatchObject({ state: 'ready', text: 'What it\'s for: Leads the web app.' });
  });

  it('asks again on reconnect when it never answered', async () => {
    connect('durable_lead');
    await cards.sync();
    state.connected.delete('durable_lead');
    await cards.sync();
    state.connected.add('durable_lead');
    await cards.sync();
    expect(sent.map((s) => s.agentId)).toEqual(['durable_lead', 'durable_lead']);
  });

  it('asks again when its page is gone (memory was cleared)', async () => {
    connect('durable_lead');
    await cards.sync();
    await cards.saveOwnCard('durable_lead', { purpose: 'Leads the web app.' });
    fs.rmSync(root, { recursive: true, force: true });
    sent = [];
    await cards.sync();
    expect(sent.map((s) => s.agentId)).toEqual(['durable_lead']);
  });
});

describe('the agent\'s own card', () => {
  it('writes the caller\'s card and nothing else', async () => {
    connect('durable_lead');
    connect('durable_qa');
    await cards.sync();
    await writeAgentNotes('qa (webapp)', 'Runs the nightly suite.', root);
    await writeAgentNotes('lead (webapp)', 'Owns the roadmap.', root);

    const result = await cards.saveOwnCard('durable_lead', { purpose: 'Leads the web app.', contactWhen: 'For planning.', owns: 'web/' });

    expect(result).toEqual({ ok: true, page: 'agents/lead-webapp.md', card: { purpose: 'Leads the web app.', contactWhen: 'For planning.', owns: 'web/' } });
    expect(await readAgentPage('lead (webapp)', root)).toEqual({
      card: 'What it\'s for: Leads the web app.\nWhen to reach it: For planning.\nOwns: web/',
      notes: 'Owns the roadmap.',
    });
    expect(await readAgentPage('qa (webapp)', root)).toEqual({ card: AGENT_CARD_PLACEHOLDER, notes: 'Runs the nightly suite.' });
    expect(await cards.status('durable_lead')).toMatchObject({ state: 'ready', asking: false });
    expect(await cards.status('durable_qa')).toMatchObject({ state: 'asking', text: NO_DESCRIPTION });
  });

  it('keeps the fields an update leaves out, on one line each', async () => {
    connect('durable_lead');
    await cards.sync();
    await cards.saveOwnCard('durable_lead', { purpose: 'Leads the web app.', owns: 'web/' });
    await cards.saveOwnCard('durable_lead', { owns: 'web/\nand docs/' });
    expect((await cards.status('durable_lead'))!.card).toEqual({ purpose: 'Leads the web app.', owns: 'web/ and docs/' });
  });

  it('refuses an agent that isn\'t connected, and the Dispatcher off', async () => {
    expect(await cards.saveOwnCard('durable_lead', { purpose: 'x' })).toEqual({ ok: false, error: NOT_CONNECTED_MESSAGE });
    connect('durable_lead');
    await cards.sync();
    state.dispatcherId = null;
    expect(await cards.saveOwnCard('durable_lead', { purpose: 'x' })).toEqual({ ok: false, error: NOT_CONNECTED_MESSAGE });
    expect(await readAgentPage('lead (webapp)', root)).toEqual({ card: AGENT_CARD_PLACEHOLDER, notes: '' });
  });

  it('takes a card from a wired agent the records haven\'t caught up with yet', async () => {
    connect('durable_lead');
    const result = await cards.saveOwnCard('durable_lead', { purpose: 'Leads the web app.' });
    expect(result).toMatchObject({ ok: true, page: 'agents/lead-webapp.md' });
  });
});

describe('an agent that doesn\'t answer', () => {
  it('reads as "No description yet" once its time to answer is up', async () => {
    connect('durable_lead');
    await cards.sync();
    expect(await cards.status('durable_lead')).toMatchObject({ state: 'asking' });

    clock += NO_ANSWER_MS + 1;
    expect(await cards.status('durable_lead')).toMatchObject({ state: 'none', asking: false, card: null, text: NO_DESCRIPTION });
    expect((await readAgentPage('lead (webapp)', root))!.card).toBe(AGENT_CARD_PLACEHOLDER);
    // Not asked again for no reason.
    await cards.sync();
    expect(sent).toHaveLength(1);
  });

  it('can still answer later', async () => {
    connect('durable_lead');
    await cards.sync();
    clock += NO_ANSWER_MS * 3;
    await cards.saveOwnCard('durable_lead', { purpose: 'Leads the web app.' });
    expect(await cards.status('durable_lead')).toMatchObject({ state: 'ready', text: 'What it\'s for: Leads the web app.' });
  });
});

describe('the agent\'s Dispatcher card in Details (#3049)', () => {
  let changes: string[];
  beforeEach(() => {
    changes = [];
    cards = new AgentCards({ ...deps(), changed: (ids) => { changes.push(...ids); } });
  });

  it('reads as the card shows it: asking, waiting for an asleep agent, ready, or no record', async () => {
    expect(await cards.view('durable_lead')).toBeNull();
    connect('durable_lead');
    connect('durable_qa');
    state.running.delete('durable_qa');
    await cards.sync();
    expect(await cards.view('durable_lead')).toEqual({ state: 'asking', card: null });
    expect(await cards.view('durable_qa')).toEqual({ state: 'none', card: null, waitingToAsk: true });
    await cards.saveOwnCard('durable_lead', { contactWhen: 'For planning.' });
    expect(await cards.view('durable_lead')).toEqual({ state: 'ready', card: { contactWhen: 'For planning.' } });
  });

  it('tells Details when a card is asked for, delivered, answered or disconnected', async () => {
    connect('durable_lead');
    state.running.delete('durable_lead');
    await cards.sync();
    expect(changes).toEqual(['durable_lead']);
    state.running.add('durable_lead');
    await cards.deliver('durable_lead');
    expect(changes).toEqual(['durable_lead', 'durable_lead']);
    await cards.saveOwnCard('durable_lead', { owns: 'web/' });
    expect(changes).toHaveLength(3);
    // Nothing changed: no word.
    await cards.sync();
    expect(changes).toHaveLength(3);
    state.connected.delete('durable_lead');
    await cards.sync();
    expect(changes).toHaveLength(4);
  });

  it('a user edit replaces what the agent wrote field by field, keeps its notes, and answers an open request', async () => {
    connect('durable_lead');
    await cards.sync();
    await writeAgentNotes('lead (webapp)', 'Owns the roadmap.', root);
    expect(await cards.view('durable_lead')).toMatchObject({ state: 'asking' });

    const result = await cards.saveUserCard('durable_lead', { contactWhen: 'Checkout\nquestions', owns: 'web/' });
    expect(result).toMatchObject({ ok: true, card: { contactWhen: 'Checkout questions', owns: 'web/' } });
    expect(await cards.view('durable_lead')).toEqual({ state: 'ready', card: { contactWhen: 'Checkout questions', owns: 'web/' } });
    expect((await readAgentPage('lead (webapp)', root))?.notes).toBe('Owns the roadmap.');
    expect(changes.at(-1)).toBe('durable_lead');

    // It keeps what the agent said it is for, and clears a field left empty.
    await cards.saveOwnCard('durable_lead', { purpose: 'Leads the web app.' });
    await cards.saveUserCard('durable_lead', { owns: '' });
    expect(await cards.view('durable_lead')).toEqual({ state: 'ready', card: { purpose: 'Leads the web app.', contactWhen: 'Checkout questions' } });
  });

  it('takes an edit right after turning on, before the records caught up, and refuses one for an agent that isn\'t connected', async () => {
    expect(await cards.saveUserCard('durable_lead', { owns: 'web/' })).toMatchObject({ ok: false });
    connect('durable_lead');
    expect(await cards.saveUserCard('durable_lead', { owns: 'web/' })).toMatchObject({ ok: true });
    state.dispatcherId = null;
    expect(await cards.saveUserCard('durable_lead', { owns: 'api/' })).toMatchObject({ ok: false });
  });

  it('refuses an edit that leaves the card empty', async () => {
    connect('durable_lead');
    await cards.sync();
    expect(await cards.saveUserCard('durable_lead', { contactWhen: '  ', owns: '' })).toMatchObject({ ok: false });
  });
});
