import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { GithubRefResult, GithubRefState } from '../../../../../shared/github-ref';
import { useAgentStore } from '../../../../stores/agentStore';
import { useProjectStore } from '../../../../stores/projectStore';
import { useUIStore } from '../../../../stores/uiStore';
import { usePluginStore } from '../../../../plugins/plugin-store';
import { Markdown } from '../MessageBlocks';
import { CommandCard } from '../ToolBlocks';
import type { ToolCallItem } from '../../../../stores/chatStore';
import { GithubRefCardBody, RichLinkProvider, RichText } from './RichLinks';
import { resetGithubRefClient, fetchGithubRef, CLIENT_TTL_MS } from './github-ref-client';
import { makeGithubRef } from './link-tokens';
import { resetRichChatContentFlag } from './rich-flag';

const MD = [
  'PR https://github.com/o/r/pull/12 and [the issue](https://github.com/me/proj/issues/3).',
  'Mentions me/proj#4, #5 and https://example.com/docs.',
  'Path src/a/b#6 stays, so does `#7` and `https://github.com/o/r/pull/8`.',
  '',
  '```',
  'see #9 https://github.com/o/r/pull/10',
  '```',
].join('\n');

const prOpen: GithubRefResult = { ok: true, details: { kind: 'pull', title: 'Add tokens', state: 'open', author: 'octo', updatedAt: new Date().toISOString(), checks: 'passing' } };

function setFlag(on: boolean) {
  vi.mocked(window.clubhouse.app.getExperimentalSettings).mockResolvedValue(on ? { richChatContent: true } : {});
}

async function renderIn(ui: React.ReactElement) {
  const r = render(<RichLinkProvider agentId="a1">{ui}</RichLinkProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return r;
}

beforeEach(() => {
  resetRichChatContentFlag();
  resetGithubRefClient();
  window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({}));
  window.clubhouse.app.openExternalUrl = vi.fn(async () => {});
  window.clubhouse.git.githubRepo = vi.fn(async () => 'me/proj');
  window.clubhouse.git.githubRef = vi.fn(async () => prOpen);
  useAgentStore.setState({ agents: { a1: { id: 'a1', projectId: 'p1', name: 'a', kind: 'durable', status: 'running', color: 'indigo' } as never } });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/repo' } as never] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('flag off', () => {
  it('renders markdown exactly as without rich content', async () => {
    setFlag(false);
    const plain = render(<Markdown text={MD} />);
    const html = plain.container.innerHTML;
    plain.unmount();
    const { container } = await renderIn(<Markdown text={MD} />);
    expect(container.innerHTML).toBe(html);
    expect(window.clubhouse.git.githubRepo).not.toHaveBeenCalled();
  });

  it('renders tool output exactly as without rich content', async () => {
    setFlag(false);
    const tool = {
      id: 't', kind: 'tool_call', toolCallId: 't', toolKind: 'execute', title: 'gh pr view', status: 'completed',
      rawInput: { command: 'gh pr view' }, content: [{ type: 'terminal', output: 'https://github.com/o/r/pull/1\n', exitCode: 0 }],
    } as unknown as ToolCallItem;
    const plain = render(<CommandCard tool={tool} />);
    fireEvent.click(plain.getByRole('button'));
    const html = plain.container.innerHTML;
    plain.unmount();
    const { container, getByRole } = await renderIn(<CommandCard tool={tool} />);
    fireEvent.click(getByRole('button'));
    expect(container.innerHTML).toBe(html);
  });
});

describe('flag on', () => {
  beforeEach(() => setFlag(true));

  it('turns references in prose into tokens, never in code or paths', async () => {
    const { container } = await renderIn(<Markdown text={MD} />);
    const tokens = Array.from(container.querySelectorAll('a[data-gh-token]')).map((a) => [a.textContent, a.getAttribute('href')]);
    expect(tokens).toEqual([
      ['o/r#12', 'https://github.com/o/r/pull/12'],
      ['the issue', 'https://github.com/me/proj/issues/3'],
      ['me/proj#4', 'https://github.com/me/proj/issues/4'],
      ['#5', 'https://github.com/me/proj/issues/5'],
    ]);
    expect(container.querySelector('a.chat-rich-link, a[href="https://example.com/docs"]')).not.toBeNull();
    expect(container.textContent).toContain('src/a/b#6');
    for (const code of Array.from(container.querySelectorAll('code'))) expect(code.querySelector('a')).toBeNull();
    // Nothing is fetched until a token is hovered.
    expect(window.clubhouse.git.githubRef).not.toHaveBeenCalled();
  });

  it('links URLs in tool output but not #123', async () => {
    const { container } = await renderIn(<pre><RichText text={'color #333\nhttps://github.com/o/r/pull/1 and https://x.io'} /></pre>);
    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://github.com/o/r/pull/1', 'https://x.io']);
    expect(container.textContent).toContain('color #333');
  });

  it('keeps tool output text as printed and a written URL’s own target', async () => {
    const out = 'https://github.com/o/r/pull/1/files#r9';
    const { container } = await renderIn(<pre><RichText text={out} /></pre>);
    const a = container.querySelector<HTMLAnchorElement>('a[data-gh-token]')!;
    expect(a.textContent).toBe(out);
    expect(a.getAttribute('href')).toBe(out);
    fireEvent(a, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
  });

  it('blocks middle-click on links', async () => {
    const { container } = await renderIn(<Markdown text="https://x.io" />);
    const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    container.querySelector('a')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('fetches on hover, shows the card, and caches and dedupes the lookup', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await renderIn(<><Markdown text="https://github.com/o/r/pull/12" /><Markdown text="again o/r#12" /></>);
    const [first, second] = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[data-gh-token]'));
    fireEvent.mouseOver(first);
    await act(async () => { vi.advanceTimersByTime(400); });
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('gh-card-title')).toHaveTextContent('Add tokens');
    expect(screen.getByTestId('gh-card-state')).toHaveTextContent('Open');
    expect(first.dataset.ghState).toBe('open');
    // A token that replaced a bare URL gains its title.
    expect(first.querySelector('.chat-gh-title')?.textContent).toBe('Add tokens');
    fireEvent.mouseOut(first, { relatedTarget: container });
    expect(screen.queryByTestId('gh-ref-card')).toBeNull();
    fireEvent.mouseOver(second);
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByTestId('gh-card-title')).toHaveTextContent('Add tokens');
    expect(window.clubhouse.git.githubRef).toHaveBeenCalledTimes(1);
  });

  it('falls back to a plain link when GitHub is unavailable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.clubhouse.git.githubRef = vi.fn(async (): Promise<GithubRefResult> => ({ ok: false, reason: 'unavailable' }));
    const { container } = await renderIn(<Markdown text="see #5" />);
    const a = container.querySelector<HTMLAnchorElement>('a[data-gh-token]')!;
    fireEvent.mouseOver(a);
    await act(async () => { vi.advanceTimersByTime(400); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByTestId('gh-ref-card')).toBeNull();
    expect(a.dataset.ghState).toBeUndefined();
    fireEvent.click(a);
    expect(window.clubhouse.app.openExternalUrl).toHaveBeenCalledWith('https://github.com/me/proj/issues/5');
  });

  it('opens the project’s own issue in the Issues view when that plugin is on', async () => {
    usePluginStore.setState({ projectEnabled: { p1: ['github-issues'] } });
    const setTab = vi.spyOn(useUIStore.getState(), 'setExplorerTab');
    const { container } = await renderIn(<Markdown text="https://github.com/me/proj/issues/3 and https://github.com/me/proj/pull/4" />);
    const [issue, pull] = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[data-gh-token]'));
    fireEvent.click(issue);
    expect(setTab).toHaveBeenCalledWith('plugin:github-issues', 'p1');
    expect(window.clubhouse.app.openExternalUrl).not.toHaveBeenCalled();
    fireEvent.click(pull);
    expect(window.clubhouse.app.openExternalUrl).toHaveBeenCalledWith('https://github.com/me/proj/pull/4');
    usePluginStore.setState({ projectEnabled: {} });
  });

  it('labels the project’s own references without the repo', async () => {
    const { container } = await renderIn(<Markdown text="https://github.com/me/proj/pull/9" />);
    expect(container.querySelector('a[data-gh-token]')?.textContent).toBe('#9');
  });
});

describe('fetchGithubRef', () => {
  it('shares one call between concurrent lookups and reuses the answer for the TTL', async () => {
    const ref = makeGithubRef('o/r', 'pull', '1');
    await Promise.all([fetchGithubRef(ref), fetchGithubRef(ref), fetchGithubRef(makeGithubRef('O/R', 'ref', '1'))]);
    expect(window.clubhouse.git.githubRef).toHaveBeenCalledTimes(1);
    await fetchGithubRef(ref, Date.now() + CLIENT_TTL_MS + 1);
    expect(window.clubhouse.git.githubRef).toHaveBeenCalledTimes(2);
  });

  it('turns an IPC failure into unavailable', async () => {
    window.clubhouse.git.githubRef = vi.fn(async () => { throw new Error('offline'); });
    expect(await fetchGithubRef(makeGithubRef('o/r', 'pull', '2'))).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('GithubRefCardBody', () => {
  it.each<[GithubRefState, string]>([['draft', 'Draft'], ['open', 'Open'], ['merged', 'Merged'], ['closed', 'Closed']])('shows the %s state', (state, label) => {
    render(<GithubRefCardBody refLabel="#1" details={{ kind: 'pull', title: 'T', state, author: 'octo', checks: 'failing' }} />);
    expect(screen.getByTestId('gh-card-state')).toHaveTextContent(label);
    expect(screen.getByText('octo')).toBeInTheDocument();
    expect(screen.getByText('Checks failing')).toBeInTheDocument();
  });

  it('shows loading before details arrive', () => {
    render(<GithubRefCardBody refLabel="#1" details={null} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
