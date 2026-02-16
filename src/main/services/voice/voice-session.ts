import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { findBinaryInPath, homePath } from '../../orchestrators/shared';
import { synthesize, agentSpeakerId } from './tts-service';

interface ActiveSession {
  cwd: string;
  model?: string;
  resumeId?: string;
  speakerId: number;
  activeProcess: ChildProcess | null;
}

let currentSession: ActiveSession | null = null;

function findClaudeBinary(): string {
  return findBinaryInPath(['claude'], [
    homePath('.local/bin/claude'),
    homePath('.claude/local/claude'),
    homePath('.npm-global/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]);
}

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows[0] || null;
}

function sendTurnChunk(text: string, audio?: Buffer): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.VOICE.TURN_CHUNK, {
      text,
      audio: audio ? audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) : undefined,
      done: false,
    });
  }
}

function sendTurnComplete(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.VOICE.TURN_COMPLETE);
  }
}

/**
 * Split text on sentence boundaries for incremental TTS.
 * Returns [completeSentences, remainder].
 */
function splitSentences(text: string): [string[], string] {
  const sentenceEnders = /([.!?])\s+/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = sentenceEnders.exec(text)) !== null) {
    sentences.push(text.slice(lastIndex, match.index + match[1].length));
    lastIndex = match.index + match[0].length;
  }

  const remainder = text.slice(lastIndex);
  return [sentences, remainder];
}

export function startSession(cwd: string, agentId: string, model?: string): { sessionId: string } {
  // Clean up any existing session
  if (currentSession?.activeProcess) {
    currentSession.activeProcess.kill();
  }

  const sessionId = `voice-${Date.now()}`;
  currentSession = {
    cwd,
    model,
    speakerId: agentSpeakerId(agentId),
    activeProcess: null,
  };

  return { sessionId };
}

export async function sendTurn(text: string): Promise<void> {
  if (!currentSession) {
    throw new Error('No active voice session');
  }

  const binary = findClaudeBinary();
  const args: string[] = [
    '-p', text,
    '--output-format', 'stream-json',
  ];

  if (currentSession.model && currentSession.model !== 'default') {
    args.push('--model', currentSession.model);
  }

  if (currentSession.resumeId) {
    args.push('--resume', currentSession.resumeId);
  }

  const proc = spawn(binary, args, {
    cwd: currentSession.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  currentSession.activeProcess = proc;

  let accumulatedText = '';
  let fullResponseText = '';
  let lineBuffer = '';

  proc.stdout?.on('data', async (chunk: Buffer) => {
    lineBuffer += chunk.toString('utf-8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        // Capture session ID for --resume on subsequent turns
        if (event.type === 'message_start' && event.message?.id) {
          if (currentSession) {
            currentSession.resumeId = event.message.id;
          }
        }

        // Extract text from content block deltas
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const newText = event.delta.text;
          accumulatedText += newText;
          fullResponseText += newText;

          // Try to split sentences for streaming TTS
          const [sentences, remainder] = splitSentences(accumulatedText);
          accumulatedText = remainder;

          for (const sentence of sentences) {
            try {
              const audio = await synthesize(sentence, currentSession?.speakerId);
              sendTurnChunk(sentence, audio);
            } catch {
              // TTS failed, send text only
              sendTurnChunk(sentence);
            }
          }
        }

        // Look for session_id in result event
        if (event.type === 'result' && event.session_id) {
          if (currentSession) {
            currentSession.resumeId = event.session_id;
          }
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    // Log but don't fail — stderr may contain progress info
    console.error('claude stderr:', chunk.toString('utf-8'));
  });

  return new Promise<void>((resolve, reject) => {
    proc.on('close', async (code) => {
      if (currentSession) {
        currentSession.activeProcess = null;
      }

      // Flush remaining text
      if (accumulatedText.trim()) {
        try {
          const audio = await synthesize(accumulatedText.trim(), currentSession?.speakerId);
          sendTurnChunk(accumulatedText.trim(), audio);
        } catch {
          sendTurnChunk(accumulatedText.trim());
        }
      }

      sendTurnComplete();

      if (code !== 0 && code !== null) {
        reject(new Error(`claude exited with code ${code}`));
      } else {
        resolve();
      }
    });

    proc.on('error', (err) => {
      if (currentSession) {
        currentSession.activeProcess = null;
      }
      sendTurnComplete();
      reject(err);
    });
  });
}

export function endSession(): void {
  if (currentSession?.activeProcess) {
    currentSession.activeProcess.kill();
  }
  currentSession = null;
}
