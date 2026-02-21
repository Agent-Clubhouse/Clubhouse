import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { VoiceConfig, VoiceInfo } from '../../../shared/types';
import { appLog } from '../log-service';

const ASSIGNMENTS_FILE = 'voice-assignments.json';

export class VoiceManager {
  private assignments = new Map<string, VoiceConfig>();
  private assignmentOrder: string[] = [];

  constructor() {
    this.load();
  }

  assignVoice(agentId: string, availableVoices: VoiceInfo[]): VoiceConfig {
    const existing = this.assignments.get(agentId);
    if (existing) return existing;

    if (availableVoices.length === 0) {
      throw new Error('No voices available to assign');
    }

    const usedIds = new Set(Array.from(this.assignments.values()).map((v) => v.voiceId));
    let chosen = availableVoices.find((v) => !usedIds.has(v.voiceId));

    if (!chosen) {
      // All voices are used; pick the LRU agent's voice
      for (const oldAgentId of this.assignmentOrder) {
        const oldVoice = this.assignments.get(oldAgentId);
        if (oldVoice) {
          chosen = availableVoices.find((v) => v.voiceId === oldVoice.voiceId);
          if (chosen) break;
        }
      }
      if (!chosen) chosen = availableVoices[0];
    }

    const config: VoiceConfig = {
      voiceId: chosen.voiceId,
      voiceName: chosen.voiceName,
      backend: 'piper-local',
    };

    this.assignments.set(agentId, config);
    this.assignmentOrder.push(agentId);
    this.save();
    return config;
  }

  getVoiceForAgent(agentId: string): VoiceConfig | undefined {
    return this.assignments.get(agentId);
  }

  setVoice(agentId: string, voice: VoiceConfig): void {
    this.assignments.set(agentId, voice);
    if (!this.assignmentOrder.includes(agentId)) {
      this.assignmentOrder.push(agentId);
    }
    this.save();
  }

  private save(): void {
    try {
      const dir = path.join(app.getPath('userData'), 'audio');
      fs.mkdirSync(dir, { recursive: true });
      const data = Object.fromEntries(this.assignments);
      fs.writeFileSync(path.join(dir, ASSIGNMENTS_FILE), JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      appLog('audio:voice', 'error', 'Failed to save voice assignments', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private load(): void {
    try {
      const filePath = path.join(app.getPath('userData'), 'audio', ASSIGNMENTS_FILE);
      if (!fs.existsSync(filePath)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const [agentId, voice] of Object.entries(data)) {
        this.assignments.set(agentId, voice as VoiceConfig);
        this.assignmentOrder.push(agentId);
      }
    } catch (err) {
      appLog('audio:voice', 'warn', 'Failed to load voice assignments', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
