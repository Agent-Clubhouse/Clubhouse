import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MINIMAL_CHAT_CAPABILITIES, type StagedChatAttachment } from '../../../../shared/chat';
import { Composer, type ComposerProps } from './Composer';
import type { ComposerAttachment } from './attachments';
import { remoteChat } from '../../../stores/remoteChatBackend';

const id = 'remote||host-a||agent';
const png = (n = 'shot.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], n, { type: 'image/png' });
const stage = vi.fn();
const send = vi.fn();
const changed = vi.fn();
const staged = (name: string): StagedChatAttachment => ({ id: `remote-${name}`, name, kind: 'image', mimeType: 'image/png', size: 4, pasted: true });
function Harness({ agent = id, session = 'session-1', text = '', images = true }: { agent?: string; session?: string; text?: string; images?: boolean }) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const props: ComposerProps = {
    agentName: 'Remote', capabilities: { ...MINIMAL_CHAT_CAPABILITIES, images }, running: false, level: 'ask', model: null, effort: null, commands: [], text,
    onTextChange: vi.fn(), onSend: send, onStop: vi.fn(), onLevelChange: vi.fn(), attachmentAgentId: agent, attachmentSessionId: session,
    attachments, onAttachmentsChange: (next) => { changed(next); setAttachments(next); },
  };
  return <Composer {...props} />;
}
const paste = (files: File[]) => fireEvent.paste(screen.getByLabelText('Message'), { clipboardData: { files } });
beforeEach(() => {
  stage.mockReset().mockImplementation(async (_id: string, file: File) => staged(file.name));
  send.mockReset(); changed.mockReset();
  window.clubhouse.chat.stageAttachment = stage;
});

describe('remote image composer', () => {
  it.each(['paste', 'drop', 'picker'])('%s stages image for exact remote target and sends only its peer-owned ID', async (method) => {
    const { container } = render(<Harness text={method === 'paste' ? 'caption' : ''} />);
    if (method === 'paste') paste([png()]);
    if (method === 'drop') fireEvent.drop(container.querySelector('[data-testid="chat-composer"]')!, { dataTransfer: { files: [png()], types: ['Files'] } });
    if (method === 'picker') fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [png()] } });
    await screen.findByTestId('chat-attachment');
    expect(stage).toHaveBeenCalledWith(id, expect.any(File), { imagesAllowed: true });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(send).toHaveBeenCalledWith(method === 'paste' ? 'caption' : '', 'send', ['remote-shot.png']);
  });
  it('preserves exact target/session/IDs through the existing remote send receipt path', async () => {
    window.clubhouse.annexClient.chatCommand = vi.fn(async () => ({ status: 'completed', result: { delivery: 'prompt', messageId: 'm' } }));
    const ids = ['image-a', 'image-b'];
    expect(await remoteChat.send(id, 'session-1', '', 'auto', ids)).toEqual({ delivery: 'prompt', messageId: 'm' });
    expect(window.clubhouse.annexClient.chatCommand).toHaveBeenCalledWith('host-a', { type: 'chat.send', agentId: 'agent', sessionId: 'session-1', text: '', delivery: 'auto', attachmentIds: ids });
  });
  it.each([{ agent: 'remote||host-b||agent', session: 'session-1' }, { agent: id, session: 'session-2' }])('discards pending upload result across host/session replacement: %j', async (next) => {
    let finish!: (value: StagedChatAttachment) => void;
    stage.mockImplementationOnce(() => new Promise<StagedChatAttachment>((resolve) => { finish = resolve; }));
    const view = render(<Harness />);
    paste([png('old.png'), png('not-started.png')]);
    expect(stage).toHaveBeenCalledOnce();
    view.rerender(<Harness {...next} />);
    await act(async () => { finish(staged('old.png')); });
    expect(stage).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-attachment')).toBeNull();
    paste([png('new.png')]);
    await screen.findByTestId('chat-attachment');
    expect(stage).toHaveBeenLastCalledWith(next.agent, expect.any(File), { imagesAllowed: true });
    expect(changed).toHaveBeenCalledWith([expect.objectContaining({ id: 'remote-new.png' })]);
  });
  it('does not publish a completed upload after composer unmount', async () => {
    let finish!: (value: StagedChatAttachment) => void;
    stage.mockImplementationOnce(() => new Promise<StagedChatAttachment>((resolve) => { finish = resolve; }));
    const view = render(<Harness />); paste([png()]); view.unmount();
    await act(async () => { finish(staged('shot.png')); });
    expect(changed).not.toHaveBeenCalled();
  });
  it('reserves max10 slots across concurrent additions', async () => {
    let finish!: (value: StagedChatAttachment) => void;
    stage.mockImplementationOnce(() => new Promise<StagedChatAttachment>((resolve) => { finish = resolve; }));
    render(<Harness />);
    paste(Array.from({ length: 10 }, (_, n) => png(`image-${n}.png`)));
    paste([png('overflow.png')]);
    expect(stage).toHaveBeenCalledOnce();
    await act(async () => { finish(staged('image-0.png')); });
    await waitFor(() => expect(screen.getAllByTestId('chat-attachment')).toHaveLength(10));
    expect(stage).toHaveBeenCalledTimes(10);
    expect(stage.mock.calls.every(([, f]) => f.name !== 'overflow.png')).toBe(true);
  });
  it('shows refusal without discarding text, sending or publishing a local-path fallback', async () => {
    stage.mockRejectedValueOnce(new Error('Remote chats take PNG, JPEG, GIF or WebP images only'));
    render(<Harness text="keep my draft" />);
    paste([new File(['private'], 'private.txt', { type: 'text/plain' })]);
    expect(await screen.findByTestId('chat-attach-error')).toHaveTextContent('PNG, JPEG, GIF or WebP');
    expect(screen.getByLabelText('Message')).toHaveTextContent('keep my draft');
    expect(changed).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});
