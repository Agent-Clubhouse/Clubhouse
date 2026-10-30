import { test, expect, type Locator, type Page } from '@playwright/test';
import * as path from 'path';
import { CHAT_MEDIA, md, type ScriptStep } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatDom, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Inline audio and video cards (#2480 area 3, Claude). One launch for the
 * whole file: the agent returns a WAV and a WebM, and the cases run in order
 * against those two cards. Nothing plays until asked, Play and pause work,
 * only one chat player plays at a time, and a card that leaves the transcript
 * (scrolled out of the 250-block window, or the chat view closed) stops and
 * resumes where it was.
 *
 * The committed tone is 0.5 s, too short to pause partway and resume (a card
 * only remembers positions past 0.5 s), so the spec writes a longer one.
 */

const AUDIO = 'long.wav';
const VIDEO = 'clip.webm';
/** Long enough that four cases of playing, pausing and resuming never reach the end. */
const AUDIO_SECONDS = 120;
const AUDIO_DURATION = '2:00';
/** Agent messages in the second turn: more than the stream's 250-block window, so turn 1 leaves it. */
const FILLER_MESSAGES = 260;

/** A mono 8 kHz 8-bit PCM WAV of a quiet 440 Hz sine. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Buffer.alloc(rate * seconds);
  for (let i = 0; i < samples.length; i++) samples[i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28); // bytes per second
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

interface MediaEvent { type: 'play' | 'playing'; kind: 'audio' | 'video'; at: number }

/** Record every play and playing event from a chat card's player, from now on. */
async function recordCardPlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __chatMediaEvents?: MediaEvent[] };
    if (w.__chatMediaEvents) return;
    const events: MediaEvent[] = [];
    w.__chatMediaEvents = events;
    for (const type of ['play', 'playing'] as const) {
      // Media events don't bubble; the capture phase still sees them.
      document.addEventListener(type, (e) => {
        const el = e.target;
        if (!(el instanceof HTMLMediaElement) || !el.closest('[data-chat-media]')) return;
        events.push({ type, kind: el instanceof HTMLVideoElement ? 'video' : 'audio', at: el.currentTime });
      }, true);
    }
  });
}

function cardEvents(page: Page): Promise<MediaEvent[]> {
  return page.evaluate(() => [...((window as unknown as { __chatMediaEvents?: MediaEvent[] }).__chatMediaEvents ?? [])]);
}

/** The first time a card's player actually played after `since` recorded events, and where it started. */
async function firstPlaying(page: Page, since: number): Promise<MediaEvent> {
  const find = async () => (await cardEvents(page)).slice(since).find((e) => e.type === 'playing');
  await expect.poll(find, { timeout: TURN_TIMEOUT }).toMatchObject({ kind: expect.any(String) });
  return (await find())!;
}

/** Media elements in the document that are playing right now. */
function playingMedia(page: Page): Promise<number> {
  return page.evaluate(() => Array.from(document.querySelectorAll('audio, video')).filter((m) => !(m as HTMLMediaElement).paused).length);
}

/** The card's player: whether it's playing, and where. */
function playerState(card: Locator) {
  return card.evaluate((el) => {
    const m = el.querySelector('audio, video') as HTMLMediaElement | null;
    return m ? { paused: m.paused, at: m.currentTime } : null;
  });
}

/** Play (or Resume) on a card that isn't open. */
const playButton = (card: Locator, name: string) => card.getByRole('button', { name: new RegExp(`^(Play|Resume) ${name.replace('.', '\\.')}`) });

let session: RichChat;
let audioPath = '';
let videoPath = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const filler: ScriptStep[] = Array.from({ length: FILLER_MESSAGES }, (_, i) => ({ type: 'text', text: `Note ${i + 1}.` }));
  session = await openRichChat({
    cli: 'claude',
    projectFiles: { [path.join('out', AUDIO)]: wav(AUDIO_SECONDS), [path.join('out', VIDEO)]: { copy: CHAT_MEDIA.webm } },
    script: ({ projectDir }) => {
      audioPath = path.join(projectDir, 'out', AUDIO);
      videoPath = path.join(projectDir, 'out', VIDEO);
      return {
        description: 'a reply returning a WAV and a WebM, then a long reply that pushes it out of the window',
        turns: [
          { steps: [{ type: 'text', text: `Here's the recording: ${md.path(audioPath)}\n\nAnd the screen capture:\n\n${md.path(videoPath)}` }] },
          { steps: filler },
        ],
      };
    },
  });
  await recordCardPlayback(session.window);
  await session.send('Record the tone and the screen.');
  await expect(chatDom(session.window).turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
});

test.afterAll(async () => {
  await session?.close();
});

const audioCard = () => session.window.locator('[data-chat-media="audio"]');
const videoCard = () => session.window.locator('[data-chat-media="video"]');

test('claude: returned audio and video become cards that load metadata but never autoplay', async () => {
  await expect(audioCard()).toHaveCount(1, { timeout: TURN_TIMEOUT });
  await expect(videoCard()).toHaveCount(1);
  await expect(audioCard()).toHaveAttribute('aria-label', `Audio: ${AUDIO}`);
  await expect(videoCard()).toHaveAttribute('aria-label', `Video: ${VIDEO}`);

  // Metadata loaded (main read the file, a detached muted element probed it)...
  await expect(audioCard().getByTestId('chat-media-duration')).toHaveText(AUDIO_DURATION, { timeout: TURN_TIMEOUT });
  await expect(videoCard().getByTestId('chat-media-duration')).toBeVisible({ timeout: TURN_TIMEOUT });
  await expect(videoCard().getByTestId('chat-media-poster')).toBeVisible({ timeout: TURN_TIMEOUT });

  // ...and still nothing plays: no player in either card, and no play event ever fired.
  await expect(audioCard()).toHaveAttribute('data-state', 'idle');
  await expect(videoCard()).toHaveAttribute('data-state', 'idle');
  await expect(session.window.locator('[data-chat-media] audio, [data-chat-media] video')).toHaveCount(0);
  expect(await playingMedia(session.window)).toBe(0);
  expect(await cardEvents(session.window)).toEqual([]);
});

test('claude: an audio card plays, pauses where it is, and resumes there after closing', async () => {
  const card = audioCard();
  await playButton(card, AUDIO).click();
  await expect(card).toHaveAttribute('data-state', 'open', { timeout: TURN_TIMEOUT });
  await expect.poll(() => playerState(card), { timeout: TURN_TIMEOUT }).toMatchObject({ paused: false, at: expect.any(Number) });
  // Past the half second a card needs before it remembers a position.
  await expect.poll(async () => (await playerState(card))?.at ?? 0, { timeout: TURN_TIMEOUT }).toBeGreaterThan(1);

  // Pause, as the native control does: the card stays open and holds its place.
  await card.locator('audio').evaluate((m: HTMLMediaElement) => m.pause());
  const paused = await playerState(card);
  expect(paused?.paused).toBe(true);
  await expect(card).toHaveAttribute('data-state', 'open');
  expect(await playingMedia(session.window)).toBe(0);

  // Close lets the source go and remembers where it stopped.
  await card.getByRole('button', { name: `Close the player for ${AUDIO}` }).click();
  await expect(card).toHaveAttribute('data-state', 'idle');
  await expect(card.locator('audio')).toHaveCount(0);
  const resume = card.getByRole('button', { name: new RegExp(`^Resume ${AUDIO.replace('.', '\\.')} from 0:0\\d$`) });
  await expect(resume).toBeVisible();

  const before = (await cardEvents(session.window)).length;
  await resume.click();
  await expect(card).toHaveAttribute('data-state', 'open', { timeout: TURN_TIMEOUT });
  const resumed = await firstPlaying(session.window, before);
  expect(resumed.at).toBeGreaterThanOrEqual(paused!.at - 0.05);

  await card.getByRole('button', { name: `Close the player for ${AUDIO}` }).click();
  await expect(card).toHaveAttribute('data-state', 'idle');
  expect(await playingMedia(session.window)).toBe(0);
});

test('claude: only one chat player plays at a time', async () => {
  const audio = audioCard();
  const video = videoCard();
  await playButton(audio, AUDIO).click();
  await expect.poll(() => playerState(audio), { timeout: TURN_TIMEOUT }).toMatchObject({ paused: false });

  // Starting the video closes the audio card's player.
  await playButton(video, VIDEO).click();
  await expect(video).toHaveAttribute('data-state', 'open', { timeout: TURN_TIMEOUT });
  await expect(audio).toHaveAttribute('data-state', 'idle', { timeout: TURN_TIMEOUT });
  await expect(audio.locator('audio')).toHaveCount(0);
  // The clip is a second long: it played, and may already have ended.
  await expect.poll(() => video.evaluate((el) => {
    const v = el.querySelector('video');
    return !!v && (v.ended || v.currentTime > 0);
  }), { timeout: TURN_TIMEOUT }).toBe(true);

  // And back: the audio closes the video's player.
  await playButton(audio, AUDIO).click();
  await expect.poll(() => playerState(audio), { timeout: TURN_TIMEOUT }).toMatchObject({ paused: false });
  await expect(video).toHaveAttribute('data-state', 'idle', { timeout: TURN_TIMEOUT });
  await expect(video.locator('video')).toHaveCount(0);
  expect(await playingMedia(session.window)).toBe(1);

  await audio.getByRole('button', { name: `Close the player for ${AUDIO}` }).click();
  await expect(audio).toHaveAttribute('data-state', 'idle');
});

test('claude: a playing card that leaves the transcript stops, and resumes where it was', async () => {
  const dom = chatDom(session.window);
  const card = audioCard();
  // Following the tail, so the next turn slides the window.
  await expect(session.window.getByTestId('chat-window-later')).toHaveCount(0);
  const played = (await cardEvents(session.window)).length;
  await playButton(card, AUDIO).click();
  const startedAt = (await firstPlaying(session.window, played)).at;
  await expect.poll(async () => (await playerState(card))?.at ?? 0, { timeout: TURN_TIMEOUT }).toBeGreaterThan(startedAt + 0.6);
  const playedTo = (await playerState(card))!.at;

  // A long reply pushes turn 1 out of the stream's window: the card unmounts mid-play.
  await session.send('Keep going.');
  await expect(dom.agentMessages.filter({ hasText: `Note ${FILLER_MESSAGES}.` })).toHaveCount(1, { timeout: TURN_TIMEOUT });
  await expect(session.chat).toHaveAttribute('data-state', 'idle', { timeout: TURN_TIMEOUT });
  await expect(session.window.getByTestId('chat-window-older')).toBeVisible();
  await expect(card).toHaveCount(0);
  expect(await playingMedia(session.window)).toBe(0);

  // Back into the window: the card offers to resume from where it stopped, and does.
  await session.window.getByTestId('chat-window-older').click();
  await expect(card).toHaveCount(1, { timeout: TURN_TIMEOUT });
  await expect(card).toHaveAttribute('data-state', 'idle');
  expect(await playingMedia(session.window)).toBe(0);
  let before = (await cardEvents(session.window)).length;
  await card.getByRole('button', { name: new RegExp(`^Resume ${AUDIO.replace('.', '\\.')} from `) }).click();
  const afterScroll = await firstPlaying(session.window, before);
  expect(afterScroll.at).toBeGreaterThanOrEqual(playedTo - 0.05);
  await expect.poll(async () => (await playerState(card))?.at ?? 0, { timeout: TURN_TIMEOUT }).toBeGreaterThan(afterScroll.at + 0.3);
  const playedTo2 = (await playerState(card))!.at;

  // Closing the transcript (another tab) unmounts it too.
  await session.window.getByTestId('explorer-tab-plugin:files').click();
  await expect(session.window.getByTestId('chat-view')).toHaveCount(0, { timeout: TURN_TIMEOUT });
  expect(await playingMedia(session.window)).toBe(0);

  await session.window.getByTestId('explorer-tab-agents').click();
  await expect(session.window.getByTestId('chat-view')).toBeVisible({ timeout: TURN_TIMEOUT });
  // A fresh stream opens on the latest messages; turn 1 is in the older window.
  await session.window.getByTestId('chat-window-older').click();
  await expect(card).toHaveCount(1, { timeout: TURN_TIMEOUT });
  await expect(card).toHaveAttribute('data-state', 'idle');
  before = (await cardEvents(session.window)).length;
  await card.getByRole('button', { name: new RegExp(`^Resume ${AUDIO.replace('.', '\\.')} from `) }).click();
  const afterReopen = await firstPlaying(session.window, before);
  expect(afterReopen.at).toBeGreaterThanOrEqual(playedTo2 - 0.05);
  await card.getByRole('button', { name: `Close the player for ${AUDIO}` }).click();
  await expect(card).toHaveAttribute('data-state', 'idle');

  await session.expectScriptComplete();
});
