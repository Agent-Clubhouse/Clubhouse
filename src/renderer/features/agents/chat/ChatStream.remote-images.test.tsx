import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { foldChatEvents } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { namespacedAgentId, namespacedProjectId, useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { useFilePreviewStore } from '../../../stores/filePreviewStore';
import { FilePreviewHost } from '../../../components/FilePreviewHost';
import { ChatStream } from './ChatStream';
import { ChatFixture, PROFILES } from './fixtures';
import { RemoteChatContext } from './remote-chat';
import { resetRichChatContentFlag } from './rich/rich-flag';
import { clearMediaCache, loadThumbnail } from './rich/media';
import { resetGithubRefClient } from './rich/github-ref-client';

const id = namespacedAgentId('satellite-a', 'agent');
const remote = { machineName: 'Satellite A' };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  clearMediaCache();
  resetRichChatContentFlag();
  resetGithubRefClient();
  useAgentStore.setState({ agents: {} });
  useProjectStore.setState({ projects: [] });
  useRemoteProjectStore.setState({ remoteAgents: { [id]: { id, projectId: namespacedProjectId('satellite-a', 'project'), name: 'Remote', kind: 'durable', status: 'running', color: 'blue', worktreePath: '/satellite/project' } } });
  useFilePreviewStore.getState().close();
  window.clubhouse.chat.readMedia = vi.fn(async () => ({ mimeType: 'image/png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }));
  window.clubhouse.chat.openLink = vi.fn(async () => ({ kind: 'file', path: '/controller/sentinel' }));
  window.clubhouse.file.preview = vi.fn(async () => ({ path: '/controller/sentinel', preview: { kind: 'text', name: 'sentinel', text: 'local', size: 5 } }));
  window.clubhouse.chat.statPaths = vi.fn(async () => []);
  window.clubhouse.chat.readFilePreview = vi.fn();
  window.clubhouse.chat.importLocalImage = vi.fn();
  window.clubhouse.chat.mediaAction = vi.fn();
  window.clubhouse.git.githubRepo = vi.fn(async () => 'controller/repo');
});

function show(text: string) {
  const f = new ChatFixture();
  const p = PROFILES.claude;
  f.start(p.driver, p.provider, p.capabilities);
  f.prompt('turn', 'Show me the report');
  f.say('turn', 'reply', text);
  f.end('turn', { stopReason: 'end_turn' });
  const state = foldChatEvents(undefined, id, f.events.map((e) => ({ ...e, agentId: id })));
  return render(<RemoteChatContext.Provider value={remote}><ChatStream state={state} /><FilePreviewHost /></RemoteChatContext.Provider>);
}

describe('remote transcript host isolation with real contexts and remote-only metadata', () => {
  it.each([true, false])('never sends a satellite absolute link to controller file APIs (rich=%s)', async (rich) => {
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ richChatContent: rich }));
    show('[report](/etc/passwd) [drive](C:/Windows/system.ini) [file](file:///etc/passwd) [relative](./notes.md) [folder](/etc/) ![local](/etc/private.png)');
    await flush();
    expect(window.clubhouse.chat.openLink).not.toHaveBeenCalled();
    expect(window.clubhouse.file.preview).not.toHaveBeenCalled();
    for (const label of ['report', 'drive', 'file', 'relative', 'folder']) fireEvent.click(screen.getByText(label));
    await flush();
    expect(window.clubhouse.chat.openLink).not.toHaveBeenCalled();
    expect(window.clubhouse.file.preview).not.toHaveBeenCalled();
    expect(window.clubhouse.chat.statPaths).not.toHaveBeenCalled();
    expect(window.clubhouse.chat.readFilePreview).not.toHaveBeenCalled();
    expect(window.clubhouse.chat.importLocalImage).not.toHaveBeenCalled();
    expect(window.clubhouse.chat.mediaAction).not.toHaveBeenCalled();
    expect(window.clubhouse.git.githubRepo).not.toHaveBeenCalled();
    expect(useFilePreviewStore.getState().target).toBeNull();
  });
});


describe('remote stored image rendering', () => {
  const ref = `${'b'.repeat(64)}.png`;
  function showImage(mediaRef: string | undefined = ref) {
    const f = new ChatFixture(); const p = PROFILES.claude;
    f.start(p.driver, p.provider, p.capabilities);
    f.emit('user_message', { messageId: 'picture', text: '', content: [{ type: 'image', mimeType: 'image/png', path: '/satellite/private.png', ...(mediaRef && { mediaRef }) }], source: 'annex', delivery: 'prompt' }, { turnId: 'turn' });
    const state = foldChatEvents(undefined, id, f.events.map((e) => ({ ...e, agentId: id })));
    return render(<RemoteChatContext.Provider value={remote}><ChatStream state={state} /></RemoteChatContext.Provider>);
  }
  it('loads ref from namespaced host, views/copies it and never offers reveal', async () => {
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ richChatContent: true }));
    showImage();
    const thumb = await screen.findByTestId('chat-attachment-thumb');
    expect(window.clubhouse.chat.readMedia).toHaveBeenCalledWith(id, ref);
    await vi.waitFor(() => expect(thumb).toHaveAttribute('aria-busy', 'false'));
    fireEvent.click(thumb);
    await screen.findByTestId('chat-image-full');
    expect(screen.queryByText(/Show in Finder|Show in Explorer|Show in folder/)).toBeNull();
    fireEvent.click(screen.getByText('Copy')); await flush();
    expect(window.clubhouse.chat.mediaAction).toHaveBeenCalledWith(id, ref, 'copy');
    expect(window.clubhouse.chat.importLocalImage).not.toHaveBeenCalled();
    expect(window.clubhouse.chat.statPaths).not.toHaveBeenCalled();
  });
  it.each([true, false])('missing/refused reference has no local path import fallback (ref=%s)', async (hasRef) => {
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ richChatContent: true }));
    window.clubhouse.chat.readMedia = vi.fn(async () => { throw new Error('authorization_revoked'); });
    showImage(hasRef ? ref : ''); await flush();
    await screen.findByTestId('chat-attachment-chip');
    expect(window.clubhouse.chat.importLocalImage).not.toHaveBeenCalled();
    expect(window.clubhouse.file.preview).not.toHaveBeenCalled();
  });
  it('flag off renders only a chip and performs no media read', async () => {
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ richChatContent: false }));
    showImage(); await flush();
    expect(window.clubhouse.chat.readMedia).not.toHaveBeenCalled();
    expect(window.clubhouse.chat.importLocalImage).not.toHaveBeenCalled();
  });
});


it('never aliases cached media refs between different hosts with the same agent/ref', async () => {
  const ref = `${'c'.repeat(64)}.png`;
  await loadThumbnail('remote||host-a||agent', ref);
  await loadThumbnail('remote||host-b||agent', ref);
  expect(window.clubhouse.chat.readMedia).toHaveBeenCalledTimes(2);
  expect(window.clubhouse.chat.readMedia).toHaveBeenNthCalledWith(1, 'remote||host-a||agent', ref);
  expect(window.clubhouse.chat.readMedia).toHaveBeenNthCalledWith(2, 'remote||host-b||agent', ref);
});
